import type { FastifyBaseLogger } from "fastify";
import type { NotificationEvent } from "../types/index.js";
import type { RecipientResolverService } from "./recipient-resolver.service.js";
import type { TelegramSender } from "./telegram.service.js";

export interface NotificationResult {
  success: boolean;
  type: NotificationEvent["type"];
  recipients: number;
  requested: number;
  sent: number;
  failed: number;
  duplicate?: boolean;
  idempotent?: boolean;
  event_id?: string;
}

export interface NotificationSender {
  send(event: NotificationEvent, integrationId?: number | null): Promise<NotificationResult>;
}

export class NotificationService {
  constructor(
    private readonly resolver: RecipientResolverService,
    private readonly telegram: TelegramSender,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn">,
  ) {}

  async send(event: NotificationEvent): Promise<NotificationResult> {
    const recipients = await this.resolver.resolve(event.type);
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
    };
  }
}
