import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { DEFAULT_CRITICAL_ALERT_POLICY } from "../../src/alerts/policy.js";
import type { AlertEvaluatorState, AlertTaskSignal, CriticalAlert, CriticalAlertCandidate, FailedDeliverySignal, PersistedAlertSeverity, SchedulerSignal } from "../../src/alerts/types.js";
import type { CriticalAlertSignalsRepository, CriticalAlertsRepository } from "../../src/repositories/critical-alerts.repository.js";
import type { ReportingRepository } from "../../src/repositories/reporting.repository.js";
import { criticalAlertsRoutes } from "../../src/routes/critical-alerts.routes.js";
import { CriticalAlertEvaluatorService } from "../../src/services/critical-alert-evaluator.service.js";
import { CriticalAlertService } from "../../src/services/critical-alert.service.js";
import { ReportingService } from "../../src/services/reporting.service.js";
import type { TelegramTaskActorResolver } from "../../src/services/task-actor.service.js";
import { TelegramOwnerConsoleService } from "../../src/telegram/owner-console.js";
import type { TaskActor } from "../../src/tasks/types.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const owner = (overrides: Partial<TaskActor> = {}): TaskActor => ({ id: 9, active: true, divisionId: 10, divisionCode: "MANAGEMENT", roleId: 3, roleCode: "OWNER",
  permissions: new Set(["alert.view_critical", "alert.acknowledge", "automation_status.view_business", "report.view_cross_division"]), ...overrides });
const task = (overrides: Partial<AlertTaskSignal> = {}): AlertTaskSignal => ({ id: 1, title: "Safe task", status: "OPEN", priority: "NORMAL", deadline: null, task_category: null, owner_division_id: 20, ...overrides });

class Signals implements CriticalAlertSignalsRepository {
  tasks: AlertTaskSignal[] = [];
  blocked = new Map<number, string>();
  deliveries: FailedDeliverySignal[] = [];
  scheduler: SchedulerSignal = { last_status: "COMPLETED", last_started_at: "2026-09-01T11:55:00.000Z", last_completed_at: "2026-09-01T11:55:01.000Z", lease_until: null };
  failed = 0; integrations = 0;
  async findActiveTasks() { return this.tasks; }
  async findBlockedSince(ids: number[]) { return new Map([...this.blocked].filter(([id]) => ids.includes(id))); }
  async findFailedDeliveries() { return this.deliveries; }
  async reminderSchedulerState() { return this.scheduler; }
  async failedDeliveryCount() { return this.failed; }
  async activeIntegrationCount() { return this.integrations; }
}

class Alerts implements CriticalAlertsRepository {
  rows: CriticalAlert[] = [];
  locked = false; writes = 0; resolves = 0;
  state: AlertEvaluatorState = { last_status: "COMPLETED", last_started_at: NOW.toISOString(), last_completed_at: NOW.toISOString(), lease_until: null,
    last_candidates: 0, last_alerts_refreshed: 0, last_alerts_resolved: 0, last_error_code: null };
  async acquire() { if (this.locked) return false; this.locked = true; return true; }
  async upsert(candidate: CriticalAlertCandidate) {
    this.writes += 1;
    let row = this.rows.find((item) => item.dedupe_key === candidate.dedupeKey && item.status !== "RESOLVED");
    if (row) { row.occurrence_count += 1; row.last_detected_at = candidate.detectedAt; row.severity = candidate.severity as PersistedAlertSeverity; return row; }
    row = { id: this.rows.length + 1, alert_type: candidate.alertType, severity: candidate.severity as PersistedAlertSeverity,
      source_type: candidate.sourceType, source_reference: candidate.sourceReference, owner_division_id: candidate.ownerDivisionId,
      task_id: candidate.taskId, status: "OPEN", dimensions: candidate.dimensions, first_detected_at: candidate.detectedAt,
      last_detected_at: candidate.detectedAt, occurrence_count: 1, dedupe_key: candidate.dedupeKey, acknowledged_at: null,
      acknowledged_by_user_id: null, resolved_at: null, summary: candidate.summary, safe_context: candidate.safeContext,
      created_at: candidate.detectedAt, updated_at: candidate.detectedAt };
    this.rows.push(row); return row;
  }
  async resolveMissing(_owner: string, seen: string[], types: string[], at: string) {
    let count = 0; for (const row of this.rows) if (row.status !== "RESOLVED" && types.includes(row.alert_type) && !seen.includes(row.dedupe_key)) { row.status = "RESOLVED"; row.resolved_at = at; count++; }
    this.resolves += count; return count;
  }
  async complete(_owner: string, status: "COMPLETED" | "FAILED", result: { candidates: number; refreshed: number; resolved: number; errorCode?: string }) {
    this.locked = false; this.state.last_status = status; this.state.last_candidates = result.candidates; this.state.last_alerts_refreshed = result.refreshed; this.state.last_alerts_resolved = result.resolved; return true;
  }
  async listActive(severity?: PersistedAlertSeverity) { return this.rows.filter((row) => row.status !== "RESOLVED" && (!severity || row.severity === severity)); }
  async findById(id: number) { return this.rows.find((row) => row.id === id) ?? null; }
  async acknowledge(id: number, actorId: number) { const row = this.rows.find((item) => item.id === id && item.status !== "RESOLVED"); if (!row) throw new Error("not found"); row.status = "ACKNOWLEDGED"; row.acknowledged_at = NOW.toISOString(); row.acknowledged_by_user_id = actorId; return row; }
  async evaluatorState() { return this.state; }
}

const evaluator = (signals = new Signals(), alerts = new Alerts()) => ({ signals, alerts,
  service: new CriticalAlertEvaluatorService(signals, alerts, DEFAULT_CRITICAL_ALERT_POLICY, true, () => NOW) });
const alertService = (signals = new Signals(), alerts = new Alerts()) => new CriticalAlertService(alerts, signals, DEFAULT_CRITICAL_ALERT_POLICY,
  { telegramPollingEnabled: true, reminderSchedulerEnabled: true, alertEvaluatorEnabled: true }, () => NOW);
const seed = async (alerts: Alerts, candidate: Partial<CriticalAlertCandidate> = {}) => alerts.upsert({ alertType: "TASK_OVERDUE", severity: "HIGH", sourceType: "TASK", sourceReference: "1", ownerDivisionId: 20,
  taskId: 1, dimensions: ["DURATION"], detectedAt: NOW.toISOString(), dedupeKey: "a".repeat(64), summary: "Safe summary", safeContext: { priority: "HIGH" }, ...candidate });

describe("deterministic Critical Alert evaluator", () => {
  it("does not alert for a terminal task", async () => expect((await evaluator().service.evaluate({ dryRun: true })).candidates).toBe(0));
  it.each(["OPEN", "IN_PROGRESS"])("detects an overdue %s task", async (status) => { const x = evaluator(); x.signals.tasks = [task({ status, deadline: "2026-08-31T10:00:00.000Z" })]; expect((await x.service.evaluate({ dryRun: true })).observations[0]).toMatchObject({ alertType: "TASK_OVERDUE", severity: "HIGH" }); });
  it("uses priority as explicit business impact", async () => { const normal = evaluator(); normal.signals.tasks = [task({ deadline: "2026-09-01T10:00:00.000Z" })]; const urgent = evaluator(); urgent.signals.tasks = [task({ deadline: "2026-09-01T10:00:00.000Z", priority: "URGENT" })]; expect((await normal.service.evaluate({ dryRun: true })).observations[0]?.severity).toBe("WARNING"); expect((await urgent.service.evaluate({ dryRun: true })).observations[0]?.severity).toBe("HIGH"); });
  it("uses the canonical audited blocked-since timestamp", async () => { const x = evaluator(); x.signals.tasks = [task({ status: "BLOCKED" })]; x.signals.blocked.set(1, "2026-08-31T10:00:00.000Z"); expect((await x.service.evaluate({ dryRun: true })).observations[0]).toMatchObject({ alertType: "TASK_BLOCKED_TOO_LONG", severity: "HIGH" }); });
  it("does not invent blocked duration when canonical audit is absent", async () => { const x = evaluator(); x.signals.tasks = [task({ status: "BLOCKED" })]; expect((await x.service.evaluate({ dryRun: true })).observations).toHaveLength(0); });
  it("keeps a transient delivery below the failed-state threshold diagnostic-free", async () => expect((await evaluator().service.evaluate({ dryRun: true })).observations).toHaveLength(0));
  it("alerts on repeated or permanent delivery failure", async () => { const x = evaluator(); x.signals.deliveries = [{ id: 7, attemptCount: 3, maxAttempts: 3, failureClass: "PERMANENT", taskId: 1, ownerDivisionId: 20 }]; expect((await x.service.evaluate({ dryRun: true })).observations[0]).toMatchObject({ alertType: "NOTIFICATION_DELIVERY_FAILURE", severity: "HIGH" }); });
  it("treats a completed scheduler with zero candidates as healthy", async () => expect((await evaluator().service.evaluate({ dryRun: true })).observations).toHaveLength(0));
  it("detects a stale scheduler", async () => { const x = evaluator(); x.signals.scheduler.last_completed_at = "2026-09-01T10:00:00.000Z"; expect((await x.service.evaluate({ dryRun: true })).observations[0]).toMatchObject({ alertType: "REMINDER_SCHEDULER_UNHEALTHY", severity: "CRITICAL" }); });
  it("dry-run writes and resolves nothing", async () => { const x = evaluator(); x.signals.tasks = [task({ deadline: "2026-08-31T10:00:00.000Z" })]; await x.service.evaluate({ dryRun: true }); expect(x.alerts.writes).toBe(0); expect(x.alerts.resolves).toBe(0); });
  it("durably deduplicates evaluator reruns", async () => { const x = evaluator(); x.signals.tasks = [task({ deadline: "2026-08-31T10:00:00.000Z" })]; await x.service.evaluate(); await x.service.evaluate(); expect(x.alerts.rows).toHaveLength(1); expect(x.alerts.rows[0]?.occurrence_count).toBe(2); });
  it("prevents concurrent evaluator overlap", async () => { const x = evaluator(); x.signals.tasks = [task({ deadline: "2026-08-31T10:00:00.000Z" })]; const results = await Promise.all([x.service.evaluate(), x.service.evaluate()]); expect(results.filter((item) => item.skippedLocked)).toHaveLength(1); expect(x.alerts.rows).toHaveLength(1); });
  it("automatically resolves after Resume or Complete removes the condition", async () => { const x = evaluator(); x.signals.tasks = [task({ status: "BLOCKED" })]; x.signals.blocked.set(1, "2026-08-31T10:00:00.000Z"); await x.service.evaluate(); x.signals.tasks = []; await x.service.evaluate(); expect(x.alerts.rows[0]?.status).toBe("RESOLVED"); });
});

describe("OWNER alert authorization and lifecycle", () => {
  it("allows cross-Divisi OWNER visibility without internal activities", async () => { const alerts = new Alerts(); await seed(alerts); const result = await alertService(new Signals(), alerts).list(owner()); expect(result[0]?.ownerDivisionId).toBe(20); expect(JSON.stringify(result)).not.toMatch(/activity|dedupe|external_id/i); });
  it("denies actors without alert permissions", async () => { const service = alertService(); await expect(service.list(owner({ roleCode: "STAFF", permissions: new Set() }))).rejects.toMatchObject({ code: "OWNER_ALERT_FORBIDDEN" }); await expect(service.list(owner({ roleCode: "ADMIN", divisionCode: "IT", permissions: new Set() }))).rejects.toMatchObject({ code: "OWNER_ALERT_FORBIDDEN" }); });
  it("acknowledgement does not resolve", async () => { const alerts = new Alerts(); await seed(alerts); const result = await alertService(new Signals(), alerts).acknowledge(owner(), 1); expect(result.status).toBe("ACKNOWLEDGED"); expect(alerts.rows[0]?.resolved_at).toBeNull(); });
  it("protects alert APIs with OWNER authorization", async () => { const alerts = new Alerts(); await seed(alerts); const app = Fastify(); await app.register(criticalAlertsRoutes, { service: alertService(new Signals(), alerts), actorResolver: { resolveOwnerActor: async () => owner() }, adminApiKey: "key" }); expect((await app.inject({ method: "GET", url: "/", headers: { "x-admin-api-key": "key" } })).statusCode).toBe(200); expect((await app.inject({ method: "POST", url: "/1/acknowledge", headers: { "x-admin-api-key": "key" } })).json().data.status).toBe("ACKNOWLEDGED"); await app.close(); });
});

class Actors implements TelegramTaskActorResolver { calls = 0; async resolveTelegramActor() { this.calls++; return owner(); } }
class EmptyReports implements ReportingRepository { async findAffiliateTasks() { return []; } }
describe("Owner Critical Alerts and Automation Status UX", () => {
  it("uses single-message compact navigation and re-authorization", async () => { const actors = new Actors(); const alerts = new Alerts(); await seed(alerts); const console = new TelegramOwnerConsoleService(actors, new ReportingService(new EmptyReports(), "Asia/Jakarta"), alertService(new Signals(), alerts)); const menu = await console.handleCallback(1, "oc:c"); const list = await console.handleCallback(1, "oc:cf:a"); expect(menu.text).toContain("Critical Alerts"); expect(list.inlineKeyboard?.flat().some((item) => item.callback_data === "oc:cd:1")).toBe(true); expect(actors.calls).toBe(2); expect(list.text.length).toBeLessThan(4096); });
  it("acknowledges through a re-authorized callback", async () => { const alerts = new Alerts(); await seed(alerts); const actors = new Actors(); const console = new TelegramOwnerConsoleService(actors, new ReportingService(new EmptyReports(), "Asia/Jakarta"), alertService(new Signals(), alerts)); const response = await console.handleCallback(1, "oc:ca:1"); expect(response.text).toContain("ACKNOWLEDGED"); expect(actors.calls).toBe(1); });
  it("renders business-safe Automation Status", async () => { const console = new TelegramOwnerConsoleService(new Actors(), new ReportingService(new EmptyReports(), "Asia/Jakarta"), alertService()); const response = await console.handleCallback(1, "oc:s"); expect(response.text).toContain("Automation Status"); expect(response.text).not.toMatch(/path|stack|key|external_id/i); });
});

describe("critical alert schema contract", () => {
  it("uses RLS, durable partial dedupe, leases, and no public policy", async () => { const sql = await readFile(path.resolve("supabase/migrations/202609010004_create_critical_alert_foundation.sql"), "utf8"); expect(sql).toContain("critical_alerts_active_dedupe_uidx"); expect(sql).toContain("pg_advisory_xact_lock"); expect(sql).toContain("enable row level security"); expect(sql).not.toMatch(/create\s+policy|disable\s+row\s+level|truncate|delete\s+from/i); });
  it("keeps alerts separate from Task lifecycle and supports only confirmed dimensions/severities", async () => { const sql = await readFile(path.resolve("supabase/migrations/202609010004_create_critical_alert_foundation.sql"), "utf8"); const types = await readFile(path.resolve("src/alerts/types.ts"), "utf8"); expect(sql).not.toMatch(/update\s+public\.tasks/); for (const value of ["NORMAL", "WARNING", "HIGH", "CRITICAL", "VALUE", "BASELINE", "DURATION", "BUSINESS_IMPACT"]) expect(types).toContain(`"${value}"`); });
});
