import { createHash, randomUUID } from "node:crypto";
import type { CriticalAlertPolicy } from "../alerts/policy.js";
import { durationSeverity } from "../alerts/policy.js";
import { ALERT_TYPES, type AlertDimension, type AlertEvaluationResult, type AlertSeverity, type CriticalAlertCandidate, type FailedDeliverySignal, type SchedulerSignal } from "../alerts/types.js";
import type { CriticalAlertSignalsRepository, CriticalAlertsRepository } from "../repositories/critical-alerts.repository.js";

const HOUR = 3_600_000;
const compact = (value: string, limit = 160) => {
  const clean = value.replace(/[\r\n\t]+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
};
const hash = (parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex");

export class CriticalAlertEvaluatorService {
  constructor(
    private readonly signals: CriticalAlertSignalsRepository,
    private readonly alerts: CriticalAlertsRepository,
    private readonly policy: CriticalAlertPolicy,
    private readonly reminderSchedulerExpected: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async evaluate(options: { dryRun: boolean; leaseSeconds?: number } = { dryRun: false }): Promise<AlertEvaluationResult> {
    const owner = randomUUID();
    if (!options.dryRun && !(await this.alerts.acquire(owner, options.leaseSeconds ?? 300))) {
      return { dryRun: false, skippedLocked: true, observations: [], candidates: 0, alertsRefreshed: 0, alertsResolved: 0 };
    }
    const observations: CriticalAlertCandidate[] = [];
    let refreshed = 0; let resolved = 0;
    try {
      observations.push(...await this.taskSignals(), ...await this.deliverySignals(), ...await this.schedulerSignals());
      const candidates = observations.filter((item) => item.severity !== "NORMAL");
      if (!options.dryRun) {
        for (const candidate of candidates) { await this.alerts.upsert(candidate); refreshed += 1; }
        resolved = await this.alerts.resolveMissing(owner, candidates.map((item) => item.dedupeKey), [...ALERT_TYPES], this.now().toISOString());
        await this.alerts.complete(owner, "COMPLETED", { candidates: candidates.length, refreshed, resolved });
      }
      return { dryRun: options.dryRun, skippedLocked: false, observations, candidates: candidates.length, alertsRefreshed: refreshed, alertsResolved: resolved };
    } catch (error) {
      if (!options.dryRun) {
        try { await this.alerts.complete(owner, "FAILED", { candidates: observations.filter((item) => item.severity !== "NORMAL").length, refreshed, resolved, errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR" }); } catch { /* retain original error */ }
      }
      throw error;
    }
  }

  private async taskSignals(): Promise<CriticalAlertCandidate[]> {
    const now = this.now();
    const tasks = await this.signals.findActiveTasks();
    const blockedSince = await this.signals.findBlockedSince(tasks.filter((task) => task.status === "BLOCKED").map((task) => task.id));
    const result: CriticalAlertCandidate[] = [];
    for (const task of tasks) {
      if (task.deadline && new Date(task.deadline) < now) {
        const hours = (now.getTime() - new Date(task.deadline).getTime()) / HOUR;
        result.push(this.taskCandidate("TASK_OVERDUE", task, task.deadline, hours, durationSeverity(hours, this.policy.overdue, task.priority), "deadline"));
      }
      const since = blockedSince.get(task.id);
      if (task.status === "BLOCKED" && since) {
        const hours = Math.max(0, (now.getTime() - new Date(since).getTime()) / HOUR);
        result.push(this.taskCandidate("TASK_BLOCKED_TOO_LONG", task, since, hours, durationSeverity(hours, this.policy.blocked, task.priority), "blocked_since"));
      }
    }
    return result;
  }

  private taskCandidate(type: "TASK_OVERDUE" | "TASK_BLOCKED_TOO_LONG", task: Awaited<ReturnType<CriticalAlertSignalsRepository["findActiveTasks"]>>[number], since: string, hours: number, severity: AlertSeverity, timeField: string): CriticalAlertCandidate {
    const dimensions: AlertDimension[] = ["DURATION"];
    if (task.priority === "HIGH" || task.priority === "URGENT" || task.task_category) dimensions.push("BUSINESS_IMPACT");
    return { alertType: type, severity, sourceType: "TASK", sourceReference: String(task.id), ownerDivisionId: task.owner_division_id,
      taskId: task.id, dimensions, detectedAt: this.now().toISOString(), dedupeKey: hash([type, "TASK", String(task.id), "policy-v1"]),
      summary: type === "TASK_OVERDUE" ? `Task overdue: ${compact(task.title)}` : `Task blocked too long: ${compact(task.title)}`,
      safeContext: { priority: task.priority, duration_hours: Number(hours.toFixed(1)), [timeField]: since, task_category: task.task_category } };
  }

  private async deliverySignals(): Promise<CriticalAlertCandidate[]> {
    return (await this.signals.findFailedDeliveries()).map((item) => this.deliveryCandidate(item));
  }
  private deliveryCandidate(item: FailedDeliverySignal): CriticalAlertCandidate {
    const severity: AlertSeverity = item.attemptCount >= 5 ? "CRITICAL" : item.failureClass === "PERMANENT" || item.attemptCount >= 3 ? "HIGH" : "WARNING";
    return { alertType: "NOTIFICATION_DELIVERY_FAILURE", severity, sourceType: "NOTIFICATION_DELIVERY", sourceReference: String(item.id),
      ownerDivisionId: item.ownerDivisionId, taskId: item.taskId, dimensions: ["BASELINE", "DURATION"], detectedAt: this.now().toISOString(),
      dedupeKey: hash(["NOTIFICATION_DELIVERY_FAILURE", "NOTIFICATION_DELIVERY", String(item.id), "policy-v1"]),
      summary: "Notification delivery failed after bounded retries.", safeContext: { attempt_count: item.attemptCount, max_attempts: item.maxAttempts, permanent: item.failureClass === "PERMANENT" } };
  }

  private async schedulerSignals(): Promise<CriticalAlertCandidate[]> {
    if (!this.reminderSchedulerExpected) return [];
    const state = await this.signals.reminderSchedulerState();
    const severity = this.schedulerSeverity(state);
    if (severity === "NORMAL") return [];
    const last = state.last_completed_at ?? state.last_started_at;
    const staleMinutes = last ? Math.max(0, (this.now().getTime() - new Date(last).getTime()) / 60_000) : null;
    return [{ alertType: "REMINDER_SCHEDULER_UNHEALTHY", severity, sourceType: "REMINDER_SCHEDULER", sourceReference: "TASK_REMINDER",
      ownerDivisionId: null, taskId: null, dimensions: ["BASELINE", "DURATION"], detectedAt: this.now().toISOString(),
      dedupeKey: hash(["REMINDER_SCHEDULER_UNHEALTHY", "REMINDER_SCHEDULER", "TASK_REMINDER", "policy-v1"]),
      summary: "Reminder scheduler requires operational attention.", safeContext: { state: state.last_status, stale_minutes: staleMinutes === null ? null : Number(staleMinutes.toFixed(1)) } }];
  }
  private schedulerSeverity(state: SchedulerSignal): AlertSeverity {
    if (state.last_status === "FAILED") return "HIGH";
    const last = state.last_completed_at ?? state.last_started_at;
    if (!last) return "WARNING";
    const stale = (this.now().getTime() - new Date(last).getTime()) / 60_000;
    return stale >= this.policy.scheduler.criticalMinutes ? "CRITICAL" : stale >= this.policy.scheduler.staleMinutes ? "HIGH" : "NORMAL";
  }
}
