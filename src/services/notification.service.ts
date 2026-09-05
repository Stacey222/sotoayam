import type { FastifyBaseLogger } from "fastify";
import type { NotificationEvent } from "../types/index.js";
import type { RecipientResolverService } from "./recipient-resolver.service.js";
import type { TelegramSender } from "./telegram.service.js";
import type { AutomationNotificationRepository } from "../repositories/automation-notifications.repository.js";

export interface NotificationResult {
  success: boolean;
  type: NotificationEvent["type"];
  recipients: number;
  requested: number;
  sent: number;
  failed: number;
  pending: number;
  retryAfterSeconds: number | null;
  deduplicated: boolean;
}

export class NotificationService {
  constructor(
    private readonly resolver: RecipientResolverService,
    private readonly telegram: TelegramSender,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn">,
    private readonly deliveries?: AutomationNotificationRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(event: NotificationEvent): Promise<NotificationResult> {
    const recipients = await this.resolver.resolve(event.type);
    if (this.deliveries) return this.sendDurably(event, recipients);
    const outcomes = await Promise.allSettled(
      recipients.map((recipient) => this.telegram.sendMessage(recipient.telegram_chat_id, event.message)),
    );
    const sent = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    const failed = outcomes.length - sent;
    if (failed > 0) this.logger.warn({ type: event.type, failed }, "Some Telegram deliveries failed");
    this.logger.info({ type: event.type, recipients: recipients.length, sent, failed }, "Notification batch completed");
    return {
      success: failed === 0,
      type: event.type,
      recipients: recipients.length,
      requested: recipients.length,
      sent,
      failed,
      pending: 0,
      retryAfterSeconds: null,
      deduplicated: false,
    };
  }

  private async sendDurably(event: NotificationEvent, recipients: Awaited<ReturnType<RecipientResolverService["resolve"]>>): Promise<NotificationResult> {
    const now = this.now();
    const stored = await this.deliveries!.createOrGet({ eventId: event.event_id, type: event.type, message: event.message, recipients });
    const due = await this.deliveries!.findDue(stored.eventId, now.toISOString(), new Date(now.getTime() - 10 * 60_000).toISOString());
    for (const delivery of due) {
      const claimed = await this.deliveries!.claim(delivery);
      if (!claimed) continue;
      const attempt = claimed.attempt_count + 1;
      try {
        await this.telegram.sendMessage(claimed.telegram_chat_id, event.message);
        await this.deliveries!.markDelivered(claimed.id, attempt, now.toISOString());
      } catch (error) {
        const transient = error instanceof Error && (error.name === "TypeError" || ("code" in error && (error as { code?: string }).code === "TELEGRAM_SEND_FAILED"));
        const exhausted = !transient || attempt >= claimed.max_attempts;
        await this.deliveries!.markFailed(claimed.id, {
          state: exhausted ? "FAILED" : "PENDING", attemptCount: attempt,
          nextAttemptAt: exhausted ? null : new Date(now.getTime() + 5 * 60_000).toISOString(),
          failureClass: transient ? "TRANSIENT" : "PERMANENT",
          failureCode: error instanceof Error && "code" in error ? String((error as { code?: string }).code ?? "DELIVERY_REJECTED") : "NETWORK_ERROR",
        });
      }
    }
    const status = await this.deliveries!.status(stored.eventId);
    const retryAfterSeconds = status.retryAt ? Math.max(1, Math.ceil((new Date(status.retryAt).getTime() - now.getTime()) / 1000)) : null;
    const success = status.pending === 0 && status.failed === 0;
    if (!success) this.logger.warn({ type: event.type, pending: status.pending, failed: status.failed }, "Automation notification delivery pending");
    this.logger.info({ type: event.type, recipients: status.requested, sent: status.sent, failed: status.failed, deduplicated: !stored.created }, "Notification batch completed");
    return { success, type: event.type, recipients: status.requested, requested: status.requested, sent: status.sent,
      failed: status.failed, pending: status.pending, retryAfterSeconds, deduplicated: !stored.created };
  }
}
