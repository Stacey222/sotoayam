import type { FastifyBaseLogger } from "fastify";
import type { ReminderEvaluatorService } from "./reminder-evaluator.service.js";
import type { CriticalAlertEvaluatorService } from "./critical-alert-evaluator.service.js";

export class ReminderSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  constructor(
    private readonly evaluator: ReminderEvaluatorService,
    readonly enabled: boolean,
    readonly intervalMs: number,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "warn">,
    private readonly criticalAlerts?: CriticalAlertEvaluatorService,
    private readonly criticalAlertsEnabled = false,
  ) {}
  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.trigger(), this.intervalMs);
    this.timer.unref();
    this.initialTimer = setTimeout(() => { this.initialTimer = null; this.trigger(); }, 1_000);
    this.initialTimer.unref();
    this.logger.info({ intervalSeconds: this.intervalMs / 1000 }, "Reminder scheduler started");
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.timer = null;
    this.initialTimer = null;
    await this.current;
  }
  private trigger(): void {
    if (this.current) return;
    this.current = (async () => {
      try {
        const result = await this.evaluator.evaluate({ dryRun: false, leaseSeconds: Math.max(60, Math.ceil(this.intervalMs / 1000) * 2) });
        this.logger.info({ tasksEvaluated: result.tasks_evaluated, candidates: result.reminder_candidates + result.escalation_candidates,
          notificationsCreated: result.notifications_created, deliveriesAttempted: result.deliveries_attempted, skippedLocked: result.skipped_locked }, "Reminder scheduler run completed");
      } catch (error) { this.logger.warn({ errorType: error instanceof Error ? error.name : "UnknownError" }, "Reminder scheduler run failed"); }
      if (this.criticalAlerts && this.criticalAlertsEnabled) {
        try {
          const result = await this.criticalAlerts.evaluate({ dryRun: false, leaseSeconds: Math.max(60, Math.ceil(this.intervalMs / 1000) * 2) });
          this.logger.info({ candidates: result.candidates, refreshed: result.alertsRefreshed, resolved: result.alertsResolved,
            skippedLocked: result.skippedLocked }, "Critical alert evaluator run completed");
        } catch (error) { this.logger.warn({ errorType: error instanceof Error ? error.name : "UnknownError" }, "Critical alert evaluator run failed"); }
      }
    })().finally(() => { this.current = null; });
  }
}
