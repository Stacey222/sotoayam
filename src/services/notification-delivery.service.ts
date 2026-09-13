import { AppError } from "../errors.js";
import type { DueDelivery, ReminderChannelsRepository, ReminderNotificationsRepository } from "../repositories/reminders.repository.js";
import type { TaskUsersRepository } from "../repositories/task-users.repository.js";
import type { FailureClass } from "../reminders/types.js";
import { TelegramOperationError, type TelegramSender } from "./telegram.service.js";
import { correlationLogger, type CorrelationContext, type CorrelationLogger } from "../observability/correlation.js";

export interface NotificationChannelAdapter {
  readonly channel: "TELEGRAM";
  deliver(externalId: string, message: string, correlation?: CorrelationContext): Promise<void>;
}

export class TelegramNotificationAdapter implements NotificationChannelAdapter {
  readonly channel = "TELEGRAM" as const;
  constructor(private readonly telegram: TelegramSender) {}
  async deliver(externalId: string, message: string, correlation?: CorrelationContext): Promise<void> {
    if (!/^[1-9]\d{0,19}$/.test(externalId)) throw new AppError(400, "CHANNEL_INVALID", "Telegram channel identity is invalid");
    const chatId = Number(externalId);
    if (!Number.isSafeInteger(chatId)) throw new AppError(400, "CHANNEL_INVALID", "Telegram channel identity is invalid");
    await this.telegram.sendMessage(chatId, message, undefined, correlation);
  }
}

export class NotificationDeliveryService {
  constructor(
    private readonly notifications: ReminderNotificationsRepository,
    private readonly users: TaskUsersRepository,
    private readonly channels: ReminderChannelsRepository,
    private readonly adapter: NotificationChannelAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly logger?: CorrelationLogger,
    private readonly correlation: CorrelationContext = {},
  ) {}

  async processDue(limit = 50): Promise<{ attempted: number; delivered: number; failed: number }> {
    const now = this.now();
    const stale = new Date(now.getTime() - 10 * 60_000).toISOString();
    const due = await this.notifications.findDue(now.toISOString(), stale, Math.min(Math.max(limit, 1), 50));
    let attempted = 0; let delivered = 0; let failed = 0;
    for (const item of due) {
      const claimed = await this.notifications.claim(item);
      if (!claimed) continue;
      attempted += 1;
      const attempt = claimed.attempt_count + 1;
      const context: CorrelationContext = {
        ...this.correlation,
        ...(this.correlation.eventId ? {} : item.notification.event?.external_event_id
          ? { eventId: item.notification.event.external_event_id } : {}),
        ...(this.correlation.notificationEventId !== undefined ? {}
          : item.notification.notification_event_id != null ? { notificationEventId: item.notification.notification_event_id } : {}),
        notificationId: item.notification_id,
        deliveryId: item.id,
      };
      const logger = this.logger ? correlationLogger(this.logger, context) : undefined;
      logger?.info({ attempt }, "Notification delivery processing started");
      try {
        const externalId = await this.resolveChannel(item);
        await this.adapter.deliver(externalId, item.notification.message, context);
        await this.notifications.markDelivered(item.id, attempt, now.toISOString());
        logger?.info({ attempt, outcome: "DELIVERED" }, "Notification delivery completed");
        delivered += 1;
      } catch (error) {
        const failure = this.classify(error);
        const exhausted = failure.class === "PERMANENT" || attempt >= claimed.max_attempts;
        const delayMinutes = attempt <= 1 ? 5 : 15;
        await this.notifications.markFailed(item.id, { state: exhausted ? "FAILED" : "PENDING", attemptCount: attempt,
          nextAttemptAt: exhausted ? null : new Date(now.getTime() + delayMinutes * 60_000).toISOString(),
          failureClass: failure.class, failureCode: failure.code });
        logger?.warn({ attempt, outcome: exhausted ? "FAILED" : "RETRY_SCHEDULED",
          failure_class: failure.class, failure_code: failure.code }, "Notification delivery failed");
        failed += 1;
      }
    }
    return { attempted, delivered, failed };
  }

  private async resolveChannel(item: DueDelivery): Promise<string> {
    const recipient = item.notification.recipient_user_id;
    if (recipient === null) throw new AppError(409, "RECIPIENT_UNAVAILABLE", "Notification recipient is unavailable");
    const user = await this.users.findById(recipient);
    if (!user?.active || user.divisionId === null || user.roleId === null) throw new AppError(409, "RECIPIENT_INACTIVE", "Notification recipient is inactive");
    const channels = await this.channels.findActiveTelegramForUser(recipient);
    if (channels.length !== 1) throw new AppError(409, channels.length === 0 ? "CHANNEL_UNAVAILABLE" : "CHANNEL_AMBIGUOUS", "A unique active Telegram channel is required");
    return channels[0]!.externalId;
  }

  private classify(error: unknown): { class: FailureClass; code: string } {
    if (error instanceof TelegramOperationError && error.code === "TELEGRAM_SEND_FAILED") {
      const classification = error.classification;
      const status = classification.transportKind === "TELEGRAM"
        ? classification.telegramErrorCode ?? classification.httpStatus
        : classification.httpStatus ?? classification.telegramErrorCode;
      // P1-02 retryability describes whether the same HTTP mutation is safe to
      // retry immediately. The durable delivery state has a separate policy:
      // definite client rejections are permanent, while ambiguous transport,
      // server, timeout, and rate-limit failures remain eligible for a later run.
      const permanentClientRejection = classification.retryable === false
        && (classification.transportKind === "HTTP" || classification.transportKind === "TELEGRAM")
        && status !== undefined && status >= 400 && status < 500
        && ![408, 425, 429].includes(status);
      return { class: permanentClientRejection ? "PERMANENT" : "TRANSIENT", code: "TELEGRAM_SEND_FAILED" };
    }
    if (error instanceof AppError) {
      if (["RECIPIENT_UNAVAILABLE", "RECIPIENT_INACTIVE", "CHANNEL_UNAVAILABLE", "CHANNEL_AMBIGUOUS", "CHANNEL_INVALID"].includes(error.code)) {
        return { class: "PERMANENT", code: error.code };
      }
      if (error.code === "TELEGRAM_SEND_FAILED") return { class: "TRANSIENT", code: "TELEGRAM_SEND_FAILED" };
      return { class: "PERMANENT", code: "DELIVERY_REJECTED" };
    }
    return { class: "TRANSIENT", code: "NETWORK_ERROR" };
  }
}
