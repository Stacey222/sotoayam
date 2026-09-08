import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRITICAL_ALERT_POLICY } from "../../src/alerts/policy.js";
import { buildApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config/env.js";
import { AppError } from "../../src/errors.js";
import { notificationPayloadHash } from "../../src/notifications/payload-hash.js";
import type { NotificationDispatchState, NotificationIntakeOutcome, NotificationIntakeRepository } from "../../src/repositories/notification-intake.repository.js";
import type { DueDelivery, ReminderNotificationsRepository } from "../../src/repositories/reminders.repository.js";
import type { TelegramUsersRepository } from "../../src/repositories/telegram-users.repository.js";
import type { FailureClass, NotificationDelivery, NotificationIntent } from "../../src/reminders/types.js";
import { notificationRoutes } from "../../src/routes/notifications.routes.js";
import { NotificationIntakeService } from "../../src/services/notification-intake.service.js";
import { NotificationDeliveryService, TelegramNotificationAdapter } from "../../src/services/notification-delivery.service.js";
import { RecipientResolverService } from "../../src/services/recipient-resolver.service.js";
import type { TelegramSender } from "../../src/services/telegram.service.js";
import type { NotificationEvent, NotificationPreference, TelegramRegistration, TelegramUser, UserFilters, UserUpdate } from "../../src/types/index.js";
import { NOTIFICATION_PREFERENCE_BY_TYPE } from "../../src/types/index.js";
import { parseNotificationEvent } from "../../src/validation.js";
import { SupabaseReminderNotificationsRepository } from "../../src/repositories/reminders.repository.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn() });
const config: AppConfig = {
  supabaseUrl: "https://example.supabase.co", supabaseServiceRoleKey: "test-service-key",
  telegramBotToken: "test-bot-token", internalApiKey: "test-internal-key", adminApiKey: "a".repeat(32),
  host: "127.0.0.1", port: 3000, telegramPollingEnabled: false, reminderSchedulerEnabled: false,
  reminderSchedulerIntervalSeconds: 300, businessTimeZone: "UTC", criticalAlertEvaluatorEnabled: false,
  criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY, logLevel: "silent",
};
const user = (overrides: Partial<TelegramUser> = {}): TelegramUser => ({
  id: 1, telegram_chat_id: 1001, telegram_username: null, telegram_first_name: null, name: "Recipient",
  division: "IT", role: "Staff", active: true, stock_alert: true, purchase_alert: true,
  sales_alert: true, marketing_alert: true, content_alert: true, owner_report: true, system_error: true,
  created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), ...overrides,
});

class Users implements TelegramUsersRepository {
  constructor(public rows: TelegramUser[] = [user()]) {}
  async findAll(_filters?: UserFilters) { return this.rows; }
  async findById(id: number) { return this.rows.find((item) => item.id === id) ?? null; }
  async findByTelegramChatId(id: number) { return this.rows.find((item) => item.telegram_chat_id === id) ?? null; }
  async upsertTelegramRegistration(_input: TelegramRegistration) { return this.rows[0]!; }
  async updateUser(_id: number, _update: UserUpdate) { return this.rows[0] ?? null; }
  async findRecipientsForNotification(preference: NotificationPreference) {
    return this.rows.filter((item) => item.active && item[preference]);
  }
}

interface StoredEvent extends NotificationIntakeOutcome {
  hash: string;
  key: string;
}

class Store implements NotificationIntakeRepository, ReminderNotificationsRepository {
  events = new Map<string, StoredEvent>();
  rows: DueDelivery[] = [];
  rowEvents = new Map<number, number>();
  intakeCalls = 0;
  failIntake = false;
  failCompleteOnce = false;
  partialExpansion = false;
  unmapped = new Set<number>();
  unrouted = new Map<number, string[]>();

  async intake(input: Parameters<NotificationIntakeRepository["intake"]>[0]): Promise<NotificationIntakeOutcome> {
    this.intakeCalls += 1;
    if (this.failIntake) throw new Error("transaction failed");
    await Promise.resolve();
    const key = `${input.source}:${input.externalEventId}`;
    const existing = this.events.get(key);
    if (existing) return { ...existing, created: false, conflict: existing.hash !== input.payloadHash };
    if (this.partialExpansion) {
      return { eventId: 999, created: true, conflict: false, recipientCount: Math.max(0, input.recipients.length - 1),
        routedCount: 0, dispatched: false, dispatchSent: 0, dispatchFailed: 0 };
    }
    const eventId = this.events.size + 1;
    let routedCount = 0;
    const unroutedKeys: string[] = [];
    for (const recipient of input.recipients) {
      if (this.unmapped.has(recipient.legacyId)) {
        unroutedKeys.push(recipient.dedupeKey);
        continue;
      }
      routedCount += 1;
      const notification: NotificationIntent = {
        id: this.rows.length + 1, task_id: null, event_type: input.eventType as NotificationIntent["event_type"],
        recipient_user_id: recipient.legacyId + 100, routing_status: "ROUTED", routing_failure_code: null,
        dedupe_key: recipient.dedupeKey, message: input.message, occurrence_at: new Date().toISOString(), created_at: new Date().toISOString(),
      };
      const deliveryId = this.rows.length + 1;
      this.rows.push({ id: deliveryId, notification_id: notification.id, channel: "TELEGRAM", state: "PENDING",
        attempt_count: 0, max_attempts: 3, scheduled_at: new Date().toISOString(), next_attempt_at: new Date().toISOString(),
        delivered_at: null, failure_class: null, failure_code: null, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), notification });
      this.rowEvents.set(deliveryId, eventId);
    }
    this.unrouted.set(eventId, unroutedKeys);
    const stored: StoredEvent = { eventId, created: true, conflict: false, recipientCount: input.recipients.length,
      routedCount, dispatched: false, dispatchSent: 0, dispatchFailed: 0, hash: input.payloadHash, key };
    this.events.set(key, stored);
    return { ...stored };
  }

  async findDueForEvent(eventId: number, now: string, staleBefore: string, limit: number) {
    return this.rows.filter((row) => this.eventIdFor(row) === eventId
      && (row.state === "PENDING" || (row.state === "PROCESSING" && row.updated_at <= staleBefore))
      && row.next_attempt_at !== null && row.next_attempt_at <= now).slice(0, limit);
  }
  async dispatchState(eventId: number): Promise<NotificationDispatchState> {
    const deliveries = this.rows.filter((row) => this.eventIdFor(row) === eventId);
    return { delivered: deliveries.filter((row) => row.state === "DELIVERED").length,
      unresolved: deliveries.filter((row) => row.state !== "DELIVERED").length,
      unroutedDedupeKeys: [...(this.unrouted.get(eventId) ?? [])] };
  }
  async completeDispatch(eventId: number, sent: number, failed: number) {
    if (this.failCompleteOnce) { this.failCompleteOnce = false; throw new Error("process stopped"); }
    const event = [...this.events.values()].find((item) => item.eventId === eventId)!;
    event.dispatched = true; event.dispatchSent = sent; event.dispatchFailed = failed;
  }
  private eventIdFor(row: DueDelivery) {
    return this.rowEvents.get(row.id);
  }
  async findDue(now: string, staleBefore: string, limit: number) { return this.findDueForEvent(1, now, staleBefore, limit); }
  async claim(delivery: DueDelivery) {
    const row = this.rows.find((item) => item.id === delivery.id);
    if (!row || row.state !== delivery.state || row.attempt_count !== delivery.attempt_count) return null;
    row.state = "PROCESSING"; row.updated_at = new Date().toISOString();
    return { ...row };
  }
  async markDelivered(id: number, attemptCount: number, deliveredAt: string) {
    const row = this.rows.find((item) => item.id === id)!;
    row.state = "DELIVERED"; row.attempt_count = attemptCount; row.delivered_at = deliveredAt; row.next_attempt_at = null;
  }
  async markFailed(id: number, input: { state: "PENDING" | "FAILED"; attemptCount: number; nextAttemptAt: string | null; failureClass: FailureClass; failureCode: string }) {
    const row = this.rows.find((item) => item.id === id)!;
    row.state = input.state; row.attempt_count = input.attemptCount; row.next_attempt_at = input.nextAttemptAt;
    row.failure_class = input.failureClass; row.failure_code = input.failureCode;
  }
  async createIntent() { return { notificationId: 0, created: false }; }
  async status() { return { pending: 0, processing: 0, delivered: 0, failed: 0, unrouted_escalations: 0 }; }
  async recent() { return []; }
}

function harness(options: { users?: TelegramUser[]; sender?: TelegramSender; store?: Store } = {}) {
  const users = new Users(options.users);
  const store = options.store ?? new Store();
  const sender = options.sender ?? { sendMessage: vi.fn().mockResolvedValue(undefined) };
  const service = new NotificationIntakeService(new RecipientResolverService(users), sender, logger(), store, store);
  return { users, store, sender, service };
}

const event = (overrides: Partial<NotificationEvent> = {}): NotificationEvent => ({
  event_id: "workflow:run:1", type: "SYSTEM_ERROR", message: "Service unavailable", metadata: { nested: { b: 2, a: 1 } }, ...overrides,
});

describe("persisted notification intake identity", () => {
  it("creates one intent, notification, and routed delivery for a first event", async () => {
    const h = harness(); const result = await h.service.send(event());
    expect(h.store.events).toHaveLength(1); expect(h.store.rows).toHaveLength(1);
    expect(result).toMatchObject({ duplicate: false, idempotent: true, recipients: 1, sent: 1, failed: 0 });
  });
  it("does not create a second intent for an identical sequential retry", async () => {
    const h = harness(); await h.service.send(event()); await h.service.send(event());
    expect(h.store.events).toHaveLength(1); expect(h.store.intakeCalls).toBe(2);
  });
  it("does not duplicate notification or delivery rows on replay", async () => {
    const h = harness(); await h.service.send(event()); await h.service.send(event()); expect(h.store.rows).toHaveLength(1);
  });
  it("does not send Telegram on an identical replay", async () => {
    const h = harness(); await h.service.send(event()); await h.service.send(event()); expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("returns the stored synchronous counts on replay", async () => {
    const h = harness(); const first = await h.service.send(event()); const replay = await h.service.send(event());
    expect(replay).toMatchObject({ ...first, duplicate: true });
  });
  it("serializes concurrent route retries behind one persisted fanout", async () => {
    const h = harness(); const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.status(error instanceof AppError ? error.statusCode : 500).send({ success: false, error: { code: error instanceof AppError ? error.code : "INTERNAL_ERROR" } }));
    await app.register(notificationRoutes, { notificationService: h.service, internalApiKey: "internal-key" });
    const request = () => app.inject({ method: "POST", url: "/send", headers: { "x-internal-api-key": "internal-key" }, payload: event() });
    const [first, second] = await Promise.all([request(), request()]);
    expect([first.json().duplicate, second.json().duplicate].sort()).toEqual([false, true]);
    expect(h.store.events).toHaveLength(1); expect(h.store.rows).toHaveLength(1); expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it("returns a stable 409 conflict for changed message reuse", async () => {
    const h = harness(); await h.service.send(event());
    await expect(h.service.send(event({ message: "Changed" }))).rejects.toMatchObject({ statusCode: 409, code: "NOTIFICATION_EVENT_CONFLICT" });
    expect(h.store.events).toHaveLength(1); expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("conflicts when metadata semantics change", async () => {
    const h = harness(); await h.service.send(event());
    await expect(h.service.send(event({ metadata: { nested: { a: 2, b: 2 } } }))).rejects.toMatchObject({ code: "NOTIFICATION_EVENT_CONFLICT" });
    expect(h.store.events).toHaveLength(1); expect(h.store.rows).toHaveLength(1); expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("canonicalizes nested metadata key ordering", async () => {
    const h = harness(); await h.service.send(event());
    const replay = await h.service.send(event({ metadata: { nested: { a: 1, b: 2 } } }));
    expect(replay.duplicate).toBe(true); expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("treats distinct event IDs with identical content as distinct intents", async () => {
    const h = harness(); await h.service.send(event()); await h.service.send(event({ event_id: "workflow:run:2" }));
    expect(h.store.events).toHaveLength(2); expect(h.sender.sendMessage).toHaveBeenCalledTimes(2);
  });
  it("persists unmapped recipients as unrouted while preserving one synchronous send", async () => {
    const h = harness(); h.store.unmapped.add(1);
    const first = await h.service.send(event()); const replay = await h.service.send(event());
    expect(h.store.rows).toHaveLength(0); expect(h.store.unrouted.get(1)).toHaveLength(1);
    expect(first).toMatchObject({ recipients: 1, sent: 1, failed: 0 }); expect(replay.duplicate).toBe(true);
    expect(h.sender.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("does not log message, metadata, payload hash, or Telegram identity", async () => {
    const testLogger = logger(); const store = new Store(); const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const service = new NotificationIntakeService(new RecipientResolverService(new Users([user({ telegram_chat_id: 99887766 })])), sender, testLogger, store, store);
    const sensitiveEvent = event({ message: "sensitive-message", metadata: { secret: "sensitive-metadata" } });
    await service.send(sensitiveEvent);
    const output = JSON.stringify([testLogger.info.mock.calls, testLogger.warn.mock.calls]);
    expect(output).not.toContain("sensitive-message"); expect(output).not.toContain("sensitive-metadata");
    expect(output).not.toContain("99887766"); expect(output).not.toContain(notificationPayloadHash(sensitiveEvent));
  });
});

describe("notification intake validation and compatibility", () => {
  it("accepts missing event_id as explicitly non-idempotent legacy traffic", async () => {
    const h = harness(); const first = await h.service.send(event({ event_id: undefined })); const second = await h.service.send(event({ event_id: undefined }));
    expect(first).toMatchObject({ idempotent: false, duplicate: false }); expect(second.idempotent).toBe(false);
    expect(h.store.events).toHaveLength(2); expect(h.sender.sendMessage).toHaveBeenCalledTimes(2);
  });
  it.each(["", "   "])("rejects an empty event ID %j", (eventId) => expect(() => parseNotificationEvent({ type: "SYSTEM_ERROR", message: "x", event_id: eventId })).toThrowError(AppError));
  it("rejects an event ID longer than 200 characters", () => expect(() => parseNotificationEvent({ type: "SYSTEM_ERROR", message: "x", event_id: "a".repeat(201) })).toThrowError(AppError));
  it("rejects control characters in an event ID", () => expect(() => parseNotificationEvent({ type: "SYSTEM_ERROR", message: "x", event_id: "run\n2" })).toThrowError(AppError));
  it.each([
    { type: "UNKNOWN", message: "x" }, { type: "SYSTEM_ERROR", message: " " },
    { type: "SYSTEM_ERROR", message: "x", metadata: [] },
  ])("preserves legacy validation for %#", (input) => expect(() => parseNotificationEvent(input)).toThrowError(AppError));
  it("hashes equivalent nested objects equally while preserving array order", () => {
    expect(notificationPayloadHash(event({ metadata: { b: 2, a: { z: 3, y: [1, 2] } } })))
      .toBe(notificationPayloadHash(event({ metadata: { a: { y: [1, 2], z: 3 }, b: 2 } })));
    expect(notificationPayloadHash(event({ metadata: { items: [1, 2] } })))
      .not.toBe(notificationPayloadHash(event({ metadata: { items: [2, 1] } })));
  });
});

describe("transaction, dispatch, and restart behavior", () => {
  it("sends nothing when the intake transaction fails", async () => {
    const h = harness(); h.store.failIntake = true; await expect(h.service.send(event())).rejects.toThrow("transaction failed");
    expect(h.store.events).toHaveLength(0); expect(h.store.rows).toHaveLength(0); expect(h.sender.sendMessage).not.toHaveBeenCalled();
  });
  it("rejects a partial expansion result instead of dispatching", async () => {
    const h = harness(); h.store.partialExpansion = true;
    await expect(h.service.send(event())).rejects.toMatchObject({ code: "NOTIFICATION_INTAKE_INCOMPLETE" });
    expect(h.store.events).toHaveLength(0); expect(h.sender.sendMessage).not.toHaveBeenCalled();
  });
  it("resumes after dispatch-summary failure without a second broadcast", async () => {
    const store = new Store(); store.failCompleteOnce = true; const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    await expect(harness({ store, sender }).service.send(event())).rejects.toThrow("process stopped");
    expect(store.events.values().next().value?.dispatched).toBe(false);
    const replay = await harness({ store, sender }).service.send(event());
    expect(replay).toMatchObject({ duplicate: true, sent: 1, failed: 0 }); expect(sender.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("leaves transient failures pending for the existing retry machinery", async () => {
    const sender = { sendMessage: vi.fn().mockRejectedValue(new Error("network")) }; const h = harness({ sender });
    const result = await h.service.send(event()); expect(result.failed).toBe(1);
    expect(h.store.rows[0]).toMatchObject({ state: "PENDING", attempt_count: 1, failure_class: "TRANSIENT", failure_code: "NETWORK_ERROR" });
  });
  it("preserves permanent terminal delivery behavior", async () => {
    const sender = { sendMessage: vi.fn().mockRejectedValue(new AppError(400, "CHANNEL_INVALID", "invalid")) }; const h = harness({ sender });
    await h.service.send(event()); expect(h.store.rows[0]).toMatchObject({ state: "FAILED", attempt_count: 1, failure_class: "PERMANENT" });
  });
  it("lets processDue consume an external notification without event-type filtering", async () => {
    const h = harness(); await h.store.intake({ source: "INTERNAL_API", externalEventId: "external", identityOrigin: "CALLER",
      eventType: "SYSTEM_ERROR", payloadHash: "a".repeat(64), message: "External", recipients: [{ legacyId: 1, dedupeKey: "b".repeat(64) }] });
    const channels = { findActiveTelegramForUser: async () => [{ userId: 101, channel: "TELEGRAM" as const, externalId: "1001" }] };
    const users = { findById: async () => ({ id: 101, displayName: null, active: true, divisionId: 1, divisionCode: "IT", roleId: 1, roleCode: "STAFF" }), findTrustedAdminActorUser: async () => { throw new Error(); } };
    const result = await new NotificationDeliveryService(h.store, users, channels, new TelegramNotificationAdapter(h.sender)).processDue();
    expect(result).toEqual({ attempted: 1, delivered: 1, failed: 0 });
  });
  it("preserves a null task_id in recent operator results", async () => {
    const query: Record<string, unknown> = {};
    query.select = () => query; query.order = () => query;
    query.limit = async () => ({ data: [{ id: 1, task_id: null, event_type: "SYSTEM_ERROR", routing_status: "ROUTED",
      routing_failure_code: null, created_at: new Date().toISOString(), notification_deliveries: { state: "DELIVERED", attempt_count: 1, failure_class: null, failure_code: null } }], error: null });
    const repository = new SupabaseReminderNotificationsRepository({ from: () => query } as never);
    expect((await repository.recent(1))[0]?.task_id).toBeNull();
  });
  it("a new service instance returns stored terminal results without sending", async () => {
    const store = new Store(); const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    await harness({ store, sender }).service.send(event()); const replay = await harness({ store, sender }).service.send(event());
    expect(replay).toMatchObject({ duplicate: true, sent: 1 }); expect(sender.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("migration and frozen mapping contracts", () => {
  it("activates persisted intake when the production repository dependencies are supplied", async () => {
    const store = new Store(); const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const { app } = await buildApp({ config, repository: new Users(), telegramSender: sender,
      notificationIntakeRepository: store, reminderNotificationsRepository: store, logger: false });
    const response = await app.inject({ method: "POST", url: "/api/notifications/send",
      headers: { "x-internal-api-key": config.internalApiKey }, payload: event() });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ duplicate: false, idempotent: true });
    const conflict = await app.inject({ method: "POST", url: "/api/notifications/send",
      headers: { "x-internal-api-key": config.internalApiKey }, payload: event({ message: "Changed" }) });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe("NOTIFICATION_EVENT_CONFLICT");
    expect(store.events).toHaveLength(1); expect(sender.sendMessage).toHaveBeenCalledTimes(1); await app.close();
  });
  it("uses database uniqueness, atomic upsert, deny-all RLS, and service-only RPC execution", async () => {
    const sql = await readFile(path.resolve("supabase/migrations/202609080001_create_notification_event_intake.sql"), "utf8");
    expect(sql).toContain("constraint notification_events_identity_uidx unique (source, external_event_id)");
    expect(sql).toContain("on conflict on constraint notification_events_identity_uidx"); expect(sql).toContain("do update set external_event_id = excluded.external_event_id");
    expect(sql).toContain("security definer"); expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("alter table public.notification_events enable row level security"); expect(sql).not.toMatch(/create\s+policy/i);
    expect(sql).toContain("from public, anon, authenticated"); expect(sql).toContain("to service_role");
    expect(sql).not.toMatch(/alter\s+table\s+public\.notification_deliveries/i);
  });
  it("keeps all seven legacy event-to-preference mappings unchanged", () => {
    expect(NOTIFICATION_PREFERENCE_BY_TYPE).toEqual({ STOCK_CRITICAL: "stock_alert", PURCHASE_RECOMMENDATION: "purchase_alert",
      SALES_FOLLOWUP: "sales_alert", MARKETING_ALERT: "marketing_alert", CONTENT_OPPORTUNITY: "content_alert",
      OWNER_DAILY_REPORT: "owner_report", SYSTEM_ERROR: "system_error" });
  });
});
