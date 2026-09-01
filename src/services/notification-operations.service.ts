import type { ReminderNotificationsRepository, ReminderSchedulerRepository } from "../repositories/reminders.repository.js";
import type { ReminderEvaluatorService } from "./reminder-evaluator.service.js";

export class NotificationOperationsService {
  constructor(
    private readonly notifications: ReminderNotificationsRepository,
    private readonly scheduler: ReminderSchedulerRepository,
    private readonly evaluator: ReminderEvaluatorService,
    private readonly schedulerEnabled: boolean,
    private readonly intervalSeconds: number,
  ) {}
  async status() {
    const [counts, runtime] = await Promise.all([this.notifications.status(), this.scheduler.status()]);
    return { scheduler: { enabled: this.schedulerEnabled, interval_seconds: this.intervalSeconds,
      last_started_at: runtime.last_started_at, last_completed_at: runtime.last_completed_at,
      last_status: runtime.last_status, lease_active: Boolean(runtime.lease_until && new Date(runtime.lease_until) > new Date()),
      last_tasks_evaluated: runtime.last_tasks_evaluated, last_candidates: runtime.last_candidates,
      last_notifications_created: runtime.last_notifications_created, last_deliveries_attempted: runtime.last_deliveries_attempted }, ...counts };
  }
  recent(limit: number) { return this.notifications.recent(Math.min(Math.max(limit, 1), 50)); }
  dryRun() { return this.evaluator.evaluate({ dryRun: true }); }
}
