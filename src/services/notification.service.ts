import type { FastifyBaseLogger } from "fastify";
import type { NotificationEvent } from "../types/index.js";
import type { RecipientResolverService } from "./recipient-resolver.service.js";
import type { TelegramSender } from "./telegram.service.js";
import { TelegramFanoutService } from "./telegram-fanout.service.js";
import type { CorrelationContext } from "../observability/correlation.js";
import { correlationLogger } from "../observability/correlation.js";

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
  send(event: NotificationEvent, integrationId?: number | null, context?: CorrelationContext): Promise<NotificationResult>;
}

export class NotificationService {
  private readonly fanout: TelegramFanoutService;

  constructor(
    private readonly resolver: RecipientResolverService,
    telegram: TelegramSender,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn">,
    fanout?: TelegramFanoutService,
  ) {
    this.fanout = fanout ?? new TelegramFanoutService(telegram);
  }

  async send(event: NotificationEvent, _integrationId?: number | null, context: CorrelationContext = {}): Promise<NotificationResult> {
    const eventId = event.event_id;
    const logger = correlationLogger(this.logger, { ...context, ...(eventId ? { eventId } : {}) });
    const recipients = await this.resolver.resolve(event.type);
    const outcomes = await this.fanout.sendAll(recipients.map((recipient) => ({
      chatId: recipient.telegram_chat_id,
      message: event.message,
      correlation: { ...context, ...(eventId ? { eventId } : {}) },
    })));
    const sent = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    const failed = outcomes.length - sent;
    if (failed > 0) logger.warn({ type: event.type, failed }, "Some Telegram deliveries failed");
    logger.info({ type: event.type, recipients: recipients.length, sent, failed }, "Notification batch completed");
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
