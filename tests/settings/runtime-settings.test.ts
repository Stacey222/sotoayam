import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRITICAL_ALERT_POLICY } from "../../src/alerts/policy.js";
import type { RuntimeSettingsRecord, RuntimeSettingsRepository } from "../../src/repositories/runtime-settings.repository.js";
import { RuntimeSettingsProvider } from "../../src/runtime/runtime-settings.js";
import { runtimeSettingsRoutes } from "../../src/routes/runtime-settings.routes.js";
import { RuntimeSettingsService } from "../../src/services/runtime-settings.service.js";
import { ReportingService } from "../../src/services/reporting.service.js";
import { ReminderSchedulerService } from "../../src/services/reminder-scheduler.service.js";
import { TrustedOwnerActorService } from "../../src/services/task-actor.service.js";
import { CriticalAlertService } from "../../src/services/critical-alert.service.js";
import { CriticalAlertEvaluatorService } from "../../src/services/critical-alert-evaluator.service.js";
import type { TaskActor } from "../../src/tasks/types.js";
import { AppError } from "../../src/errors.js";

const baseline = { businessTimeZone: "UTC", reminderSchedulerIntervalSeconds: 300,
  criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY };
const owner = (id = 7): TaskActor => ({ id, displayName: `Owner ${id}`, active: true, divisionId: 1,
  divisionCode: "OPERATIONS", divisionActive: true, roleId: 3, roleCode: "OWNER", roleActive: true,
  permissions: new Set(["threshold.manage", "report.view_cross_division"]) });
const admin = (): TaskActor => ({ ...owner(1), roleCode: "ADMIN", permissions: new Set() });
const record = (patch: Partial<RuntimeSettingsRecord> = {}): RuntimeSettingsRecord => ({ business_time_zone: null,
  reminder_scheduler_interval_seconds: null, critical_alert_policy: null, business_actor_user_id: null,
  business_actor_display_name: null, business_actor_eligible: false, version: 0, updated_at: null, ...patch });
class Repository implements RuntimeSettingsRepository {
  value = record(); updates = 0;
  async get() { return this.value; }
  async updateRuntime(input: Parameters<RuntimeSettingsRepository["updateRuntime"]>[0]) { this.updates++;
    this.value = record({ business_time_zone: input.businessTimeZone,
      reminder_scheduler_interval_seconds: input.reminderSchedulerIntervalSeconds,
      critical_alert_policy: input.criticalAlertPolicy, version: input.expectedVersion + 1, updated_at: new Date().toISOString() }); return this.value; }
  async setBusinessActor(input: Parameters<RuntimeSettingsRepository["setBusinessActor"]>[0]) { this.value = { ...this.value,
    business_actor_user_id: input.userId, business_actor_display_name: "Owner", business_actor_eligible: true,
    version: input.expectedVersion + 1 }; return this.value; }
}
async function service(repository = new Repository()) { const provider = new RuntimeSettingsProvider(baseline);
  const service = new RuntimeSettingsService(repository, provider, baseline); await service.load(); return { service, provider, repository }; }

describe("P2-01 runtime settings", () => {
  afterEach(() => vi.useRealTimers());
  it("S-01 returns only the deployment baseline when persistence is empty", async () => {
    const x = await service(); expect(x.service.current(owner(), false)).toEqual({ version: 0,
      runtime: { business_time_zone: "UTC", reminder_scheduler_interval_seconds: 300,
        critical_alert_policy: DEFAULT_CRITICAL_ALERT_POLICY }, source: "DEPLOYMENT_DEFAULT", business_actor: null, updated_at: null });
  });
  it("S-02 reloads a complete persisted snapshot as authoritative runtime state", async () => { const repository = new Repository();
    repository.value = record({ business_time_zone: "Asia/Jakarta", reminder_scheduler_interval_seconds: 120,
      critical_alert_policy: { ...DEFAULT_CRITICAL_ALERT_POLICY, scheduler: { staleMinutes: 5, criticalMinutes: 10 } }, version: 4 });
    const x = await service(repository); expect(x.provider.current()).toMatchObject({ businessTimeZone: "Asia/Jakarta",
      reminderSchedulerIntervalSeconds: 120, criticalAlertPolicy: { scheduler: { staleMinutes: 5, criticalMinutes: 10 } } });
    expect(x.service.current(owner(), false).source).toBe("RUNTIME");
  });
  it("S-03/S-04/S-05 rejects invalid timezone, cadence, and strict policy", async () => { const x = await service();
    const valid = { expectedVersion: 0, businessTimeZone: "Asia/Jakarta", reminderSchedulerIntervalSeconds: 120,
      criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY, reason: "valid" };
    await expect(x.service.updateRuntime(owner(), { ...valid, businessTimeZone: "Mars/Base" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(x.service.updateRuntime(owner(), { ...valid, reminderSchedulerIntervalSeconds: 59 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(x.service.updateRuntime(owner(), { ...valid, criticalAlertPolicy: { ...DEFAULT_CRITICAL_ALERT_POLICY, secret: 1 } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("S-08 does not reload after a rejected unchanged update", async () => { const repository = new Repository();
    repository.updateRuntime = vi.fn().mockRejectedValue(new Error("SETTINGS_UNCHANGED")); const x = await service(repository);
    const reload = vi.fn(); x.service.setIntervalUpdater(reload);
    await expect(x.service.updateRuntime(owner(), { expectedVersion: 0, businessTimeZone: "UTC", reminderSchedulerIntervalSeconds: 300,
      criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY, reason: "same" })).rejects.toMatchObject({ code: "SETTINGS_UNCHANGED" }); expect(reload).not.toHaveBeenCalled();
  });
  it("S-09 reporting reads the latest timezone snapshot per request", async () => { const x = await service();
    const reports = new ReportingService({ findTasksForReport: vi.fn().mockResolvedValue([]) }, x.provider, () => new Date("2026-09-14T12:00:00Z"));
    expect((await reports.taskStatus(owner(), {}, "TODAY")).timeZone).toBe("UTC");
    x.provider.apply({ ...baseline, businessTimeZone: "Asia/Jakarta" });
    expect((await reports.taskStatus(owner(), {}, "TODAY")).timeZone).toBe("Asia/Jakarta");
  });
  it("S-10 alert evaluator and automation health consume the next policy snapshot", async () => { const x = await service();
    const now = new Date("2026-09-14T12:00:00Z");
    const signals = { findActiveTasks: vi.fn().mockResolvedValue([{ id: 1, title: "late", status: "OPEN", priority: "NORMAL",
      task_category: null, deadline: "2026-09-14T10:00:00Z", owner_division_id: 1 }]), findBlockedSince: vi.fn().mockResolvedValue(new Map()),
      findFailedDeliveries: vi.fn().mockResolvedValue([]), reminderSchedulerState: vi.fn().mockResolvedValue({ last_status: "COMPLETED",
        last_started_at: null, last_completed_at: "2026-09-14T11:55:00Z" }), failedDeliveryCount: vi.fn().mockResolvedValue(0),
      activeIntegrationCount: vi.fn().mockResolvedValue(1) };
    const alerts = { acquire: vi.fn(), upsert: vi.fn(), resolveMissing: vi.fn(), complete: vi.fn(), listActive: vi.fn(), findById: vi.fn(),
      acknowledge: vi.fn(), evaluatorState: vi.fn().mockResolvedValue({ last_status: "COMPLETED", last_completed_at: "2026-09-14T11:55:00Z" }) };
    const evaluator = new CriticalAlertEvaluatorService(signals as never, alerts as never, x.provider, true, () => now);
    const operations = new CriticalAlertService(alerts as never, signals as never, x.provider,
      { telegramPollingEnabled: true, reminderSchedulerEnabled: true, alertEvaluatorEnabled: true }, () => now);
    expect((await evaluator.evaluate({ dryRun: true })).candidates).toBe(1);
    expect((await operations.automationStatus({ ...owner(), permissions: new Set(["automation_status.view_business"]) })).overall).toBe("HEALTHY");
    x.provider.apply({ ...baseline, criticalAlertPolicy: { overdue: { warningHours: 10, highHours: 20, criticalHours: 30 },
      blocked: DEFAULT_CRITICAL_ALERT_POLICY.blocked, scheduler: { staleMinutes: 2, criticalMinutes: 3 } } });
    expect((await evaluator.evaluate({ dryRun: true })).observations.find((item) => item.alertType === "TASK_OVERDUE")?.severity).toBe("NORMAL");
    expect((await operations.automationStatus({ ...owner(), permissions: new Set(["automation_status.view_business"]) })).overall).toBe("DEGRADED");
  });
  it("S-11 replaces one scheduler timer and cleans up on close", async () => { vi.useFakeTimers();
    const scheduler = new ReminderSchedulerService({ evaluate: vi.fn().mockResolvedValue({ tasks_evaluated: 0, reminder_candidates: 0,
      escalation_candidates: 0, notifications_created: 0, deliveries_attempted: 0, skipped_locked: false }) } as never,
    true, 300_000, { info: vi.fn(), warn: vi.fn() }); scheduler.start(); const count = vi.getTimerCount();
    scheduler.updateIntervalMs(120_000); expect(vi.getTimerCount()).toBe(count); await scheduler.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("S-12 rejects deployment-only fields structurally", async () => { const x = await service(); const app = await routeApp(x.service, owner());
    const response = await app.inject({ method: "PATCH", url: "/runtime", headers: { "x-csrf-token": "ok" }, payload: {
      expected_version: 0, business_time_zone: "UTC", reminder_scheduler_interval_seconds: 300,
      critical_alert_policy: DEFAULT_CRITICAL_ALERT_POLICY, reason: "test", telegram_bot_token: "forbidden" } });
    expect(response.statusCode).toBe(400); await app.close();
  });
  it("O-01/O-02 resolves the exact OWNER session without singleton ambiguity", async () => { const x = await service();
    const first = await routeApp(x.service, owner(7), 7); const second = await routeApp(x.service, owner(8), 8);
    expect((await first.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    expect((await second.inject({ method: "GET", url: "/" })).statusCode).toBe(200); await first.close(); await second.close();
  });
  it("O-01/O-02 actor resolver loads each session identity and shared compatibility uses only designation", async () => {
    const users = { findById: vi.fn(async (id: number) => ({ ...owner(id), permissions: undefined })),
      findTrustedAdminActorUser: vi.fn(), findTrustedOwnerActorUser: vi.fn(), findDesignatedBusinessActorUser: vi.fn(async () => ({ ...owner(9), permissions: undefined })) };
    const resolver = new TrustedOwnerActorService(users as never, { findForRoleCode: vi.fn(async () => [
      { code: "report.view_cross_division", active: true }]) } as never);
    expect((await resolver.resolveOwnerActor({ kind: "session", adminUserId: 7, sessionId: "s", email: "a@b.co",
      displayName: "A", expiresAt: "2099-01-01" })).id).toBe(7);
    expect((await resolver.resolveOwnerActor({ kind: "session", adminUserId: 8, sessionId: "t", email: "b@b.co",
      displayName: "B", expiresAt: "2099-01-01" })).id).toBe(8);
    expect((await resolver.resolveOwnerActor({ kind: "shared-api-key" })).id).toBe(9);
    expect(users.findTrustedOwnerActorUser).not.toHaveBeenCalled();
  });
  it("O-07 fails closed when the shared-key designated actor is unavailable", async () => {
    const resolver = new TrustedOwnerActorService({ findById: vi.fn(), findTrustedAdminActorUser: vi.fn(),
      findDesignatedBusinessActorUser: vi.fn().mockResolvedValue(null) } as never, { findForRoleCode: vi.fn() } as never);
    await expect(resolver.resolveOwnerActor({ kind: "shared-api-key" })).rejects.toMatchObject({ code: "OWNER_ACTOR_UNAVAILABLE" });
  });
  it("O-03/O-04 keeps OWNER and SYSTEM_ADMIN permissions independent", async () => { const x = await service();
    await expect(x.service.updateRuntime(admin(), { expectedVersion: 0, businessTimeZone: "UTC", reminderSchedulerIntervalSeconds: 300,
      criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY, reason: "denied" })).rejects.toMatchObject({ code: "RUNTIME_SETTINGS_FORBIDDEN" });
  });
  it("O-05 allows a dual-authority actor without substituting identity", async () => { const x = await service();
    expect(x.service.current(owner(9), true).version).toBe(0);
  });
  it("O-06 shared keys cannot read or mutate settings", async () => { const x = await service(); const app = Fastify();
    await app.register(runtimeSettingsRoutes, { service: x.service, actorResolver: {} as never, adminApiKey: "a".repeat(32) });
    for (const method of ["GET", "PATCH"] as const) { const response = await app.inject({ method, url: method === "GET" ? "/" : "/runtime",
      headers: { "x-admin-api-key": "a".repeat(32) }, payload: method === "PATCH" ? {} : undefined }); expect(response.statusCode).toBe(401); }
    await app.close();
  });
  it("A-01 marks GET as admin-read and PATCH as admin-write with CSRF", async () => { const x = await service(); const app = await routeApp(x.service, owner());
    const routes = app.printRoutes(); expect(routes).toContain("runtime");
    expect((await app.inject({ method: "PATCH", url: "/runtime", payload: {} })).statusCode).toBe(403); await app.close();
  });
  it("A-02 password-change-required is denied before settings resolution", async () => { const x = await service(); const app = await routeApp(x.service, owner(), 7, true);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(403); await app.close();
  });
  it("A-03 DTO contains no deployment or credential inventory", async () => { const x = await service();
    expect(JSON.stringify(x.service.current(owner(), false))).not.toMatch(/token|secret|password|supabase|telegram|host|rate.?limit/i);
  });
});

async function routeApp(settings: RuntimeSettingsService, actor: TaskActor, id = actor.id, passwordChangeRequired = false) {
  const app = Fastify(); const principal = { kind: "session" as const, adminUserId: id, sessionId: crypto.randomUUID(),
    email: `u${id}@example.test`, displayName: `User ${id}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), passwordChangeRequired };
  await app.register(runtimeSettingsRoutes, { service: settings, actorResolver: {
    resolveTrustedActor: async () => actor, resolveSessionActor: async () => actor,
    resolveActor: async () => { if (actor.roleCode !== "ADMIN") throw new AppError(403, "ADMIN_AUTHORITY_REQUIRED", "forbidden"); return actor; },
  }, sessionAuthenticator: { authenticate: async () => principal, verifyCsrf: (request) => request.headers["x-csrf-token"] === "ok" } });
  return app;
}
