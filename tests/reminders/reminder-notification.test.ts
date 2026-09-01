import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import type { DueDelivery, ReminderChannel, ReminderChannelsRepository, ReminderNotificationsRepository, ReminderRoutingRepository, ReminderSchedulerRepository, ReminderStateRepository, ReminderTasksRepository, SchedulerStateView } from "../../src/repositories/reminders.repository.js";
import type { TaskUsersRepository } from "../../src/repositories/task-users.repository.js";
import { TaskReminderPolicy } from "../../src/reminders/reminder-policy.js";
import type { FailureClass, NotificationDelivery, NotificationIntent, NotificationRoutingRule, TaskReminderState } from "../../src/reminders/types.js";
import { adminNotificationsRoutes } from "../../src/routes/admin-notifications.routes.js";
import { NotificationDeliveryService, type NotificationChannelAdapter } from "../../src/services/notification-delivery.service.js";
import { ReminderEvaluatorService } from "../../src/services/reminder-evaluator.service.js";
import { ReminderRoutingService } from "../../src/services/reminder-routing.service.js";
import type { Task, TaskActor, TaskUser } from "../../src/tasks/types.js";

const now = new Date("2026-09-01T12:00:00.000Z");
const task = (overrides: Partial<Task> = {}): Task => ({ id: 1, title: "Review deployment", description: null,
  status: "OPEN", priority: "NORMAL", source: "MANUAL", source_reference: null, created_by_user_id: 1,
  integration_id: null, import_batch_id: null, requesting_division_id: 10, owner_division_id: 10,
  assigned_to_user_id: 2, deadline: "2026-09-02T06:00:00.000Z", started_at: null, completed_at: null,
  cancelled_at: null, created_at: "2026-08-31T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", ...overrides });
const state = (overrides: Partial<TaskReminderState> = {}): TaskReminderState => ({ task_id: 1, last_reminder_at: null,
  next_reminder_at: null, reminder_count: 0, last_escalation_at: null, next_escalation_at: null,
  escalation_count: 0, last_evaluated_at: now.toISOString(), created_at: now.toISOString(), updated_at: now.toISOString(), ...overrides });
const policy = new TaskReminderPolicy();

describe("deterministic reminder policy", () => {
  it.each(["COMPLETED", "CANCELLED"] as const)("does not remind terminal %s tasks", (status) => expect(policy.evaluate(task({ status }), null, now)).toEqual([]));
  it("selects an OPEN task approaching deadline", () => expect(policy.evaluate(task(), null, now)[0]?.reason).toBe("APPROACHING_DEADLINE"));
  it("selects an IN_PROGRESS task approaching deadline", () => expect(policy.evaluate(task({ status: "IN_PROGRESS" }), null, now)[0]?.eventType).toBe("TASK_REMINDER"));
  it("selects a BLOCKED task after the deterministic threshold", () => expect(policy.evaluate(task({ status: "BLOCKED", deadline: null, updated_at: "2026-08-31T11:00:00.000Z" }), null, now)[0]?.reason).toBe("BLOCKED"));
  it("selects an overdue task", () => expect(policy.evaluate(task({ deadline: "2026-09-01T11:00:00.000Z" }), null, now)[0]?.reason).toBe("OVERDUE"));
  it("uses priority-specific approach windows", () => { expect(policy.evaluate(task({ priority: "LOW", deadline: "2026-09-02T18:00:00.000Z" }), null, now)).toHaveLength(0); expect(policy.evaluate(task({ priority: "URGENT", deadline: "2026-09-02T18:00:00.000Z" }), null, now)).toHaveLength(1); });
  it("respects persisted next-reminder eligibility", () => expect(policy.evaluate(task(), state({ next_reminder_at: "2026-09-01T13:00:00.000Z" }), now)).toEqual([]));
  it("creates escalation after the reminder threshold", () => expect(policy.evaluate(task(), state({ reminder_count: 3, next_reminder_at: "2026-09-02T00:00:00.000Z" }), now)[0]?.eventType).toBe("TASK_ESCALATION"));
  it("creates escalation for a task overdue by 48 hours", () => expect(policy.evaluate(task({ deadline: "2026-08-30T11:00:00.000Z" }), null, now).some((item) => item.eventType === "TASK_ESCALATION")).toBe(true));
});

class Users implements TaskUsersRepository {
  rows: TaskUser[] = [{ id: 2, displayName: "Assignee", active: true, divisionId: 10, roleId: 1, roleCode: "STAFF" }];
  async findById(id: number) { return this.rows.find((row) => row.id === id) ?? null; }
  async findTrustedAdminActorUser() { return this.rows[0]!; }
}
class Channels implements ReminderChannelsRepository {
  rows: ReminderChannel[] = [{ userId: 2, channel: "TELEGRAM", externalId: "100200300" }];
  async findActiveTelegramForUser(userId: number) { return this.rows.filter((row) => row.userId === userId); }
}
class Rules implements ReminderRoutingRepository {
  row: NotificationRoutingRule | null = null;
  async findEscalationRule() { return this.row; }
}

describe("safe recipient routing", () => {
  it("routes reminders only to the active assigned user normalized channel", async () => { const result = await new ReminderRoutingService(new Users(), new Channels(), new Rules()).resolve(policy.evaluate(task(), null, now)[0]!); expect(result).toEqual({ userId: 2, routed: true }); });
  it("does not broadcast an unassigned task", async () => { const result = await new ReminderRoutingService(new Users(), new Channels(), new Rules()).resolve(policy.evaluate(task({ assigned_to_user_id: null }), null, now)[0]!); expect(result).toMatchObject({ routed: false, reason: "UNASSIGNED" }); });
  it("rejects a disabled or missing Telegram channel", async () => { const channels = new Channels(); channels.rows = []; const result = await new ReminderRoutingService(new Users(), channels, new Rules()).resolve(policy.evaluate(task(), null, now)[0]!); expect(result).toMatchObject({ routed: false, reason: "CHANNEL_MISSING" }); });
  it("does not guess between multiple active channels", async () => { const channels = new Channels(); channels.rows.push({ userId: 2, channel: "TELEGRAM", externalId: "400500600" }); const result = await new ReminderRoutingService(new Users(), channels, new Rules()).resolve(policy.evaluate(task(), null, now)[0]!); expect(result.reason).toBe("CHANNEL_AMBIGUOUS"); });
  it("records escalation as unrouted when no explicit rule exists", async () => { const candidate = policy.evaluate(task(), state({ reminder_count: 3, next_reminder_at: "2026-09-02T00:00:00.000Z" }), now)[0]!; const result = await new ReminderRoutingService(new Users(), new Channels(), new Rules()).resolve(candidate); expect(result).toMatchObject({ userId: null, routed: false, reason: "ESCALATION_UNROUTED" }); });
});

class Notifications implements ReminderNotificationsRepository {
  keys = new Map<string, number>(); due: DueDelivery[] = []; marks: Array<Record<string, unknown>> = [];
  async createIntent(input: { dedupeKey: string }) { const existing = this.keys.get(input.dedupeKey); if (existing) return { notificationId: existing, created: false }; const id = this.keys.size + 1; this.keys.set(input.dedupeKey, id); return { notificationId: id, created: true }; }
  async findDue() { return this.due; }
  async claim(delivery: DueDelivery) { return delivery; }
  async markDelivered(id: number, attemptCount: number, deliveredAt: string) { this.marks.push({ id, state: "DELIVERED", attemptCount, deliveredAt }); }
  async markFailed(id: number, input: { state: "PENDING" | "FAILED"; attemptCount: number; nextAttemptAt: string | null; failureClass: FailureClass; failureCode: string }) { this.marks.push({ id, ...input }); const row = this.due.find((item) => item.id === id); if (row) { row.attempt_count = input.attemptCount; row.state = input.state; row.next_attempt_at = input.nextAttemptAt; } }
  async status() { return { pending: 0, processing: 0, delivered: 0, failed: 0, unrouted_escalations: 0 }; }
  async recent() { return []; }
}
class Tasks implements ReminderTasksRepository { rows = [task()]; async findCandidates() { return this.rows; } }
class States implements ReminderStateRepository { rows = new Map<number, TaskReminderState>(); async findForTasks() { return this.rows; } }
class Scheduler implements ReminderSchedulerRepository {
  acquired = true; completions: string[] = [];
  async acquire() { return this.acquired; }
  async complete(_owner: string, status: "COMPLETED" | "FAILED") { this.completions.push(status); return true; }
  async status(): Promise<SchedulerStateView> { return { last_started_at: null, last_completed_at: null, last_status: "IDLE", last_tasks_evaluated: 0, last_candidates: 0, last_notifications_created: 0, last_deliveries_attempted: 0, lease_until: null }; }
}
class Adapter implements NotificationChannelAdapter { readonly channel = "TELEGRAM" as const; calls: Array<{ externalId: string; message: string }> = []; error: unknown = null; async deliver(externalId: string, message: string) { this.calls.push({ externalId, message }); if (this.error) throw this.error; } }
function intent(overrides: Partial<NotificationIntent> = {}): NotificationIntent { return { id: 1, task_id: 1, event_type: "TASK_REMINDER", recipient_user_id: 2, routing_status: "ROUTED", routing_failure_code: null, dedupe_key: "a".repeat(64), message: "Reminder", occurrence_at: now.toISOString(), created_at: now.toISOString(), ...overrides }; }
function due(overrides: Partial<DueDelivery> = {}): DueDelivery { return { id: 1, notification_id: 1, channel: "TELEGRAM", state: "PENDING", attempt_count: 0, max_attempts: 3, scheduled_at: now.toISOString(), next_attempt_at: now.toISOString(), delivered_at: null, failure_class: null, failure_code: null, created_at: now.toISOString(), updated_at: now.toISOString(), notification: intent(), ...overrides }; }

describe("delivery and bounded retry", () => {
  it("records successful Telegram delivery", async () => { const notifications = new Notifications(); notifications.due = [due()]; const adapter = new Adapter(); const result = await new NotificationDeliveryService(notifications, new Users(), new Channels(), adapter, () => now).processDue(); expect(result).toEqual({ attempted: 1, delivered: 1, failed: 0 }); expect(notifications.marks[0]).toMatchObject({ state: "DELIVERED", attemptCount: 1 }); });
  it("classifies network failure as transient and schedules retry", async () => { const notifications = new Notifications(); notifications.due = [due()]; const adapter = new Adapter(); adapter.error = new Error("network"); await new NotificationDeliveryService(notifications, new Users(), new Channels(), adapter, () => now).processDue(); expect(notifications.marks[0]).toMatchObject({ state: "PENDING", failureClass: "TRANSIENT", failureCode: "NETWORK_ERROR" }); });
  it("stops retrying at the bounded maximum", async () => { const notifications = new Notifications(); notifications.due = [due({ attempt_count: 2 })]; const adapter = new Adapter(); adapter.error = new AppError(502, "TELEGRAM_SEND_FAILED", "rejected"); await new NotificationDeliveryService(notifications, new Users(), new Channels(), adapter, () => now).processDue(); expect(notifications.marks[0]).toMatchObject({ state: "FAILED", attemptCount: 3 }); });
  it("permanently fails if recipient is deactivated after generation", async () => { const notifications = new Notifications(); notifications.due = [due()]; const users = new Users(); users.rows[0]!.active = false; await new NotificationDeliveryService(notifications, users, new Channels(), new Adapter(), () => now).processDue(); expect(notifications.marks[0]).toMatchObject({ state: "FAILED", failureCode: "RECIPIENT_INACTIVE" }); });
  it("permanently fails a missing channel without sending", async () => { const notifications = new Notifications(); notifications.due = [due()]; const channels = new Channels(); channels.rows = []; const adapter = new Adapter(); await new NotificationDeliveryService(notifications, new Users(), channels, adapter, () => now).processDue(); expect(notifications.marks[0]).toMatchObject({ state: "FAILED", failureCode: "CHANNEL_UNAVAILABLE" }); expect(adapter.calls).toHaveLength(0); });
  it("does not expose Telegram external IDs in persisted failure metadata", async () => { const notifications = new Notifications(); notifications.due = [due()]; const adapter = new Adapter(); adapter.error = new Error("failure containing transport internals"); await new NotificationDeliveryService(notifications, new Users(), new Channels(), adapter, () => now).processDue(); expect(JSON.stringify(notifications.marks)).not.toContain("100200300"); });
});

function evaluatorHarness() {
  const tasks = new Tasks(); const states = new States(); const notifications = new Notifications(); const users = new Users(); const channels = new Channels(); const rules = new Rules(); const scheduler = new Scheduler(); const adapter = new Adapter();
  const delivery = new NotificationDeliveryService(notifications, users, channels, adapter, () => now);
  const evaluator = new ReminderEvaluatorService(tasks, states, notifications, new ReminderRoutingService(users, channels, rules), delivery, scheduler, policy, () => now);
  return { evaluator, tasks, states, notifications, scheduler, adapter };
}

describe("evaluator persistence boundaries", () => {
  it("durably deduplicates repeated evaluator runs", async () => { const h = evaluatorHarness(); expect((await h.evaluator.evaluate({ dryRun: false, owner: "00000000-0000-4000-8000-000000000001" })).notifications_created).toBe(1); expect((await h.evaluator.evaluate({ dryRun: false, owner: "00000000-0000-4000-8000-000000000002" })).notifications_created).toBe(0); expect(h.notifications.keys.size).toBe(1); });
  it("skips safely when another scheduler owns the durable lease", async () => { const h = evaluatorHarness(); h.scheduler.acquired = false; const result = await h.evaluator.evaluate({ dryRun: false }); expect(result.skipped_locked).toBe(true); expect(h.notifications.keys.size).toBe(0); });
  it("dry-run creates nothing and sends nothing", async () => { const h = evaluatorHarness(); const result = await h.evaluator.evaluate({ dryRun: true }); expect(result.reminder_candidates).toBe(1); expect(h.notifications.keys.size).toBe(0); expect(h.adapter.calls).toHaveLength(0); expect(h.scheduler.completions).toHaveLength(0); });
  it("completed production-like task produces zero candidate", async () => { const h = evaluatorHarness(); h.tasks.rows = [task({ status: "COMPLETED", completed_at: now.toISOString() })]; expect((await h.evaluator.evaluate({ dryRun: true })).reminder_candidates).toBe(0); });
});

describe("IT operational API", () => {
  it("requires the shared key before resolving SYSTEM_ADMIN", async () => { const app = Fastify(); const resolver = { resolveTrustedActor: vi.fn() }; await app.register(adminNotificationsRoutes, { service: {} as never, actorResolver: resolver as never, adminApiKey: "admin-key" }); const response = await app.inject({ method: "GET", url: "/status" }); expect(response.statusCode).toBe(401); expect(resolver.resolveTrustedActor).not.toHaveBeenCalled(); await app.close(); });
  it("returns bounded safe status to the trusted normalized authority", async () => { const app = Fastify(); const operationalActor: TaskActor = { ...new Users().rows[0]!, permissions: new Set() }; const service = { status: vi.fn().mockResolvedValue({ pending: 0 }), recent: vi.fn(), dryRun: vi.fn() }; await app.register(adminNotificationsRoutes, { service: service as never, actorResolver: { resolveTrustedActor: async () => operationalActor }, adminApiKey: "admin-key" }); const response = await app.inject({ method: "GET", url: "/status", headers: { "x-admin-api-key": "admin-key" } }); expect(response.statusCode).toBe(200); expect(response.json().data).toEqual({ pending: 0 }); await app.close(); });
});

describe("Slice 7 migration and compatibility contract", () => {
  const migration = path.resolve(process.cwd(), "supabase/migrations/202609010002_create_task_notification_foundation.sql");
  it("enables RLS without public policies or speculative business routes", async () => { const sql = await readFile(migration, "utf8"); expect(sql.match(/enable row level security/g)).toHaveLength(5); expect(sql).not.toMatch(/create\s+policy/i); expect(sql).not.toMatch(/insert\s+into\s+public\.notification_routing_rules/i); });
  it("uses database dedupe and durable overlap protection", async () => { const sql = await readFile(migration, "utf8"); expect(sql).toContain("dedupe_key text not null unique"); expect(sql).toContain("pg_advisory_xact_lock"); expect(sql).toContain("try_acquire_reminder_scheduler_lease"); });
  it("does not change stored Task lifecycle or legacy notification flags", async () => { const sql = await readFile(migration, "utf8"); expect(sql).not.toMatch(/alter\s+table\s+public\.telegram_users/i); expect(sql).not.toMatch(/['\"]OVERDUE['\"]/); for (const field of ["stock_alert", "purchase_alert", "sales_alert", "marketing_alert", "content_alert", "owner_report", "system_error"]) expect(sql).not.toContain(field); });
});
