import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { AppError } from "../errors.js";
import { notificationPayloadHash, notificationRecipientDedupeKey } from "../notifications/payload-hash.js";
import type { NotificationIntakeRepository, NotificationIntakeRecipient } from "../repositories/notification-intake.repository.js";
import type { DueDelivery, ReminderChannelsRepository, ReminderNotificationsRepository } from "../repositories/reminders.repository.js";
import type { TaskUsersRepository } from "../repositories/task-users.repository.js";
import type { FailureClass, NotificationDelivery } from "../reminders/types.js";
import type { TaskUser } from "../tasks/types.js";
import type { NotificationEvent, TelegramUser } from "../types/index.js";
import { NotificationDeliveryService, TelegramNotificationAdapter } from "./notification-delivery.service.js";
import type { NotificationResult, NotificationSender } from "./notification.service.js";
import type { RecipientResolverService } from "./recipient-resolver.service.js";
import type { TelegramSender } from "./telegram.service.js";
import { TelegramFanoutService } from "./telegram-fanout.service.js";

const SOURCE = "INTERNAL_API";

class EventDeliveryRepository implements ReminderNotificationsRepository {
  constructor(
    private readonly eventId: number,
    private readonly intake: NotificationIntakeRepository,
    private readonly deliveries: ReminderNotificationsRepository,
    private readonly scopeRows: (rows: DueDelivery[]) => DueDelivery[],
  ) {}

  async findDue(now: string, staleBefore: string, limit: number): Promise<DueDelivery[]> {
    const rows = await this.intake.findDueForEvent(this.eventId, now, staleBefore, limit);
    return this.scopeRows(rows);
  }
  claim(delivery: DueDelivery): Promise<NotificationDelivery | null> { return this.deliveries.claim(delivery); }
  markDelivered(id: number, attemptCount: number, deliveredAt: string): Promise<void> {
    return this.deliveries.markDelivered(id, attemptCount, deliveredAt);
  }
  markFailed(id: number, input: { state: "PENDING" | "FAILED"; attemptCount: number; nextAttemptAt: string | null; failureClass: FailureClass; failureCode: string }): Promise<void> {
    return this.deliveries.markFailed(id, input);
  }
  createIntent(): never { throw new Error("Task notification creation is unavailable in event scope"); }
  status(): never { throw new Error("Global notification status is unavailable in event scope"); }
  recent(): never { throw new Error("Recent notifications are unavailable in event scope"); }
}

class SnapshotUsers implements TaskUsersRepository {
  constructor(private readonly chatIds: Map<number, number>) {}
  async findById(id: number): Promise<TaskUser | null> {
    return this.chatIds.has(id)
      ? { id, displayName: null, active: true, divisionId: 1, divisionCode: "INTAKE", roleId: 1, roleCode: "INTAKE" }
      : null;
  }
  async findTrustedAdminActorUser(): Promise<TaskUser> { throw new Error("Trusted actor lookup is unavailable in event scope"); }
}

class SnapshotChannels implements ReminderChannelsRepository {
  constructor(private readonly chatIds: Map<number, number>) {}
  async findActiveTelegramForUser(userId: number) {
    const chatId = this.chatIds.get(userId);
    return chatId === undefined ? [] : [{ userId, channel: "TELEGRAM" as const, externalId: String(chatId) }];
  }
}

export class NotificationIntakeService implements NotificationSender {
  private readonly active = new Map<string, Promise<NotificationResult>>();
  private readonly fanout: TelegramFanoutService;

  constructor(
    private readonly resolver: RecipientResolverService,
    telegram: TelegramSender,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn">,
    private readonly intake: NotificationIntakeRepository,
    private readonly deliveries: ReminderNotificationsRepository,
    fanout?: TelegramFanoutService,
  ) {
    this.fanout = fanout ?? new TelegramFanoutService(telegram);
  }

  async send(event: NotificationEvent, integrationId: number | null = null): Promise<NotificationResult> {
    const externalEventId = event.event_id ?? `gen:${randomUUID()}`;
    const identityOrigin = event.event_id === undefined ? "GENERATED" as const : "CALLER" as const;
    const identity = `${SOURCE}\u0000${externalEventId}`;
    while (true) {
      const preceding = this.active.get(identity);
      if (preceding) {
        try { await preceding; } catch { /* A committed unfinished intent is resumed below. */ }
        if (this.active.get(identity) === preceding) this.active.delete(identity);
        continue;
      }
      const operation = this.persistAndDispatch(event, externalEventId, identityOrigin, integrationId);
      this.active.set(identity, operation);
      try {
        return await operation;
      } finally {
        if (this.active.get(identity) === operation) this.active.delete(identity);
      }
    }
  }

  private async persistAndDispatch(
    event: NotificationEvent,
    externalEventId: string,
    identityOrigin: "CALLER" | "GENERATED",
    integrationId: number | null,
  ): Promise<NotificationResult> {
    const recipients = await this.resolver.resolve(event.type);
    const recipientExpansion = recipients.map<NotificationIntakeRecipient>((recipient) => ({
      legacyId: recipient.id,
      dedupeKey: notificationRecipientDedupeKey(SOURCE, externalEventId, recipient.id),
    }));
    const outcome = await this.intake.intake({
      source: SOURCE,
      externalEventId,
      identityOrigin,
      eventType: event.type,
      payloadHash: notificationPayloadHash(event),
      message: event.message,
      recipients: recipientExpansion,
      integrationId,
    });

    if (outcome.conflict) {
      this.logger.warn({ notificationEventId: outcome.eventId, source: SOURCE, externalEventId, outcome: "CONFLICT" }, "Notification event identity conflict");
      throw new AppError(409, "NOTIFICATION_EVENT_CONFLICT", "This event_id was already accepted with a different payload");
    }
    if (outcome.created && (outcome.recipientCount !== recipients.length || outcome.routedCount > outcome.recipientCount)) {
      throw new AppError(503, "NOTIFICATION_INTAKE_INCOMPLETE", "Notification event expansion was incomplete");
    }

    const classification = outcome.created ? "CREATED" : outcome.dispatched ? "REPLAY" : "RESUMED";
    const commonLog = {
      notificationEventId: outcome.eventId,
      source: SOURCE,
      externalEventId,
      identityOrigin,
      type: event.type,
      outcome: classification,
      recipients: outcome.recipientCount,
      routed: outcome.routedCount,
      unrouted: outcome.recipientCount - outcome.routedCount,
    };
    if (identityOrigin === "GENERATED") this.logger.warn(commonLog, "Notification event has generated non-idempotent identity");
    else this.logger.info(commonLog, "Notification event persisted");

    if (outcome.dispatched) return this.result(event, externalEventId, identityOrigin, true, outcome.recipientCount, outcome.dispatchSent, outcome.dispatchFailed);

    const recipientByKey = new Map(recipientExpansion.map((item, index) => [item.dedupeKey, recipients[index]!]));
    const chatIdsByUser = new Map<number, number>();
    const scopedRepository = new EventDeliveryRepository(outcome.eventId, this.intake, this.deliveries, (rows) => {
      const scopedRows = rows.filter((row) => recipientByKey.has(row.notification.dedupe_key));
      for (const row of scopedRows) {
        const recipient = recipientByKey.get(row.notification.dedupe_key);
        if (row.notification.recipient_user_id !== null && recipient) {
          chatIdsByUser.set(row.notification.recipient_user_id, recipient.telegram_chat_id);
        }
      }
      return scopedRows;
    });
    const deliveryService = new NotificationDeliveryService(
      scopedRepository,
      new SnapshotUsers(chatIdsByUser),
      new SnapshotChannels(chatIdsByUser),
      new TelegramNotificationAdapter(this.fanout),
    );
    for (let batch = 0; batch < 10; batch += 1) {
      const processed = await deliveryService.processDue(50);
      if (processed.attempted === 0) break;
    }

    const dispatchState = await this.intake.dispatchState(outcome.eventId);
    const unroutedRecipients = dispatchState.unroutedDedupeKeys
      .map((key) => recipientByKey.get(key))
      .filter((recipient): recipient is TelegramUser => recipient !== undefined);
    const unroutedOutcomes = await this.fanout.sendAll(unroutedRecipients.map((recipient) => ({
      chatId: recipient.telegram_chat_id,
      message: event.message,
    })));
    const unroutedSent = unroutedOutcomes.filter((item) => item.status === "fulfilled").length;
    const missingUnrouted = dispatchState.unroutedDedupeKeys.length - unroutedRecipients.length;
    const sent = dispatchState.delivered + unroutedSent;
    const failed = dispatchState.unresolved + (unroutedOutcomes.length - unroutedSent) + missingUnrouted;
    await this.intake.completeDispatch(outcome.eventId, sent, failed);
    this.logger.info({ notificationEventId: outcome.eventId, source: SOURCE, externalEventId,
      outcome: classification, deliveryCount: outcome.routedCount, sent, failed }, "Notification event dispatch completed");
    return this.result(event, externalEventId, identityOrigin, !outcome.created, outcome.recipientCount, sent, failed);
  }

  private result(
    event: NotificationEvent,
    externalEventId: string,
    identityOrigin: "CALLER" | "GENERATED",
    duplicate: boolean,
    recipients: number,
    sent: number,
    failed: number,
  ): NotificationResult {
    return {
      success: failed === 0,
      type: event.type,
      recipients,
      requested: recipients,
      sent,
      failed,
      duplicate,
      idempotent: identityOrigin === "CALLER",
      ...(identityOrigin === "CALLER" ? { event_id: externalEventId } : {}),
    };
  }
}
