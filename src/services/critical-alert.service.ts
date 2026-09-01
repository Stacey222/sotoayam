import { AppError } from "../errors.js";
import type { AutomationStatus, CriticalAlert, PersistedAlertSeverity } from "../alerts/types.js";
import type { CriticalAlertSignalsRepository, CriticalAlertsRepository } from "../repositories/critical-alerts.repository.js";
import type { TaskActor } from "../tasks/types.js";
import type { CriticalAlertPolicy } from "../alerts/policy.js";

export class CriticalAlertService {
  constructor(
    private readonly alerts: CriticalAlertsRepository,
    private readonly signals: CriticalAlertSignalsRepository,
    private readonly policy: CriticalAlertPolicy,
    private readonly runtime: { telegramPollingEnabled: boolean; telegramPollingActive?: () => boolean; reminderSchedulerEnabled: boolean; alertEvaluatorEnabled: boolean },
    private readonly now: () => Date = () => new Date(),
  ) {}
  async list(actor: TaskActor, severity?: PersistedAlertSeverity) {
    this.assertOwner(actor);
    return (await this.alerts.listActive(severity)).map((item) => this.safe(item));
  }
  async get(actor: TaskActor, id: number) {
    this.assertOwner(actor);
    const alert = await this.alerts.findById(id);
    if (!alert) throw new AppError(404, "CRITICAL_ALERT_NOT_FOUND", "Critical alert not found");
    return this.safe(alert);
  }
  async acknowledge(actor: TaskActor, id: number) {
    this.assertOwner(actor);
    return this.safe(await this.alerts.acknowledge(id, actor.id));
  }
  async automationStatus(actor: TaskActor): Promise<AutomationStatus> {
    this.assertOwner(actor);
    const [scheduler, evaluator, failed, integrations] = await Promise.all([
      this.signals.reminderSchedulerState(), this.alerts.evaluatorState(), this.signals.failedDeliveryCount(), this.signals.activeIntegrationCount(),
    ]);
    const reminder = !this.runtime.reminderSchedulerEnabled ? "DEGRADED" as const : this.operationalState(scheduler.last_status, scheduler.last_completed_at, this.policy.scheduler.staleMinutes);
    const critical = !this.runtime.alertEvaluatorEnabled ? "DEGRADED" as const : this.operationalState(evaluator.last_status, evaluator.last_completed_at, this.policy.scheduler.staleMinutes);
    const pollingHealthy = this.runtime.telegramPollingEnabled && (this.runtime.telegramPollingActive?.() ?? true);
    const values = [reminder, critical, failed > 0 ? "DEGRADED" as const : "HEALTHY" as const, pollingHealthy ? "HEALTHY" as const : "DEGRADED" as const];
    return { overall: values.includes("UNHEALTHY") ? "UNHEALTHY" : values.includes("DEGRADED") ? "DEGRADED" : "HEALTHY",
      runtime: "HEALTHY", telegramPolling: pollingHealthy ? "HEALTHY" : "DEGRADED",
      reminderScheduler: reminder, criticalAlertEvaluator: critical, notificationDelivery: failed > 0 ? "DEGRADED" : "HEALTHY", activeIntegrations: integrations };
  }
  assertOwner(actor: TaskActor): void {
    if (!actor.active || actor.divisionId === null || actor.roleId === null || actor.roleCode !== "OWNER") throw new AppError(403, "OWNER_ALERT_FORBIDDEN", "Active normalized OWNER authority is required");
  }
  private operationalState(status: string, completedAt: string | null, staleMinutes: number): "HEALTHY" | "DEGRADED" | "UNHEALTHY" {
    if (status === "FAILED") return "UNHEALTHY";
    if (!completedAt || this.now().getTime() - new Date(completedAt).getTime() > staleMinutes * 60_000 * 2) return "DEGRADED";
    return "HEALTHY";
  }
  private safe(alert: CriticalAlert) {
    return { id: alert.id, type: alert.alert_type, severity: alert.severity, status: alert.status,
      affectedReference: alert.task_id ? `Task #${alert.task_id}` : alert.source_type === "REMINDER_SCHEDULER" ? "Reminder scheduler" : "Notification delivery",
      ownerDivisionId: alert.owner_division_id, firstDetectedAt: alert.first_detected_at, lastDetectedAt: alert.last_detected_at,
      occurrenceCount: alert.occurrence_count, acknowledgedAt: alert.acknowledged_at, resolvedAt: alert.resolved_at,
      summary: alert.summary, context: alert.safe_context };
  }
}
