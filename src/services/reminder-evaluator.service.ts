import { createHash, randomUUID } from "node:crypto";
import type { ReminderNotificationsRepository, ReminderSchedulerRepository, ReminderStateRepository, ReminderTasksRepository } from "../repositories/reminders.repository.js";
import type { ReminderCandidate, ReminderEvaluationResult } from "../reminders/types.js";
import { TaskReminderPolicy } from "../reminders/reminder-policy.js";
import type { NotificationDeliveryService } from "./notification-delivery.service.js";
import type { ReminderRoutingService } from "./reminder-routing.service.js";

const emptyResult = (dryRun: boolean): ReminderEvaluationResult => ({ dry_run: dryRun, tasks_evaluated: 0,
  reminder_candidates: 0, escalation_candidates: 0, notifications_created: 0, unrouted: 0,
  would_create_notifications: 0, unrouted_escalations: 0,
  deliveries_attempted: 0, delivered: 0, failed: 0, skipped_locked: false });

export class ReminderEvaluatorService {
  constructor(
    private readonly tasks: ReminderTasksRepository,
    private readonly states: ReminderStateRepository,
    private readonly notifications: ReminderNotificationsRepository,
    private readonly routing: ReminderRoutingService,
    private readonly delivery: NotificationDeliveryService,
    private readonly schedulerState: ReminderSchedulerRepository,
    private readonly policy = new TaskReminderPolicy(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async evaluate(options: { dryRun: boolean; owner?: string; leaseSeconds?: number } = { dryRun: false }): Promise<ReminderEvaluationResult> {
    const result = emptyResult(options.dryRun);
    const owner = options.owner ?? randomUUID();
    let acquired = false;
    if (!options.dryRun) {
      acquired = await this.schedulerState.acquire(owner, options.leaseSeconds ?? 300);
      if (!acquired) return { ...result, skipped_locked: true };
    }
    try {
      const tasks = await this.tasks.findCandidates(100);
      result.tasks_evaluated = tasks.length;
      const states = await this.states.findForTasks(tasks.map((task) => task.id));
      const candidates = tasks.flatMap((task) => this.policy.evaluate(task, states.get(task.id) ?? null, this.now()));
      result.reminder_candidates = candidates.filter((item) => item.eventType === "TASK_REMINDER").length;
      result.escalation_candidates = candidates.filter((item) => item.eventType === "TASK_ESCALATION").length;
      result.would_create_notifications = candidates.length;
      for (const candidate of candidates) {
        const recipient = await this.routing.resolve(candidate);
        if (!recipient.routed) {
          result.unrouted += 1;
          if (candidate.eventType === "TASK_ESCALATION") result.unrouted_escalations += 1;
        }
        if (options.dryRun) continue;
        const created = await this.notifications.createIntent({ taskId: candidate.task.id, eventType: candidate.eventType,
          recipientUserId: recipient.userId, dedupeKey: this.dedupe(candidate, recipient.userId),
          routingFailureCode: recipient.reason ?? null,
          message: this.message(candidate), occurrenceAt: candidate.occurrenceAt.toISOString(),
          nextEligibleAt: candidate.nextEligibleAt.toISOString() });
        if (created.created) result.notifications_created += 1;
      }
      if (!options.dryRun) {
        const delivery = await this.delivery.processDue(50);
        result.deliveries_attempted = delivery.attempted; result.delivered = delivery.delivered; result.failed = delivery.failed;
        await this.schedulerState.complete(owner, "COMPLETED", { tasks: result.tasks_evaluated,
          candidates: result.reminder_candidates + result.escalation_candidates,
          notifications: result.notifications_created, deliveries: result.deliveries_attempted });
      }
      return result;
    } catch (error) {
      if (acquired) await this.schedulerState.complete(owner, "FAILED", { tasks: result.tasks_evaluated,
        candidates: result.reminder_candidates + result.escalation_candidates,
        notifications: result.notifications_created, deliveries: result.deliveries_attempted }).catch(() => false);
      throw error;
    }
  }

  private dedupe(candidate: ReminderCandidate, recipientUserId: number | null): string {
    return createHash("sha256").update([candidate.task.id, candidate.eventType, recipientUserId ?? "UNROUTED", candidate.occurrenceAt.toISOString()].join(":"), "utf8").digest("hex");
  }
  private message(candidate: ReminderCandidate): string {
    const heading = candidate.eventType === "TASK_ESCALATION" ? "Eskalasi tugas" : "Pengingat tugas";
    const deadline = candidate.task.deadline ? `\nDeadline: ${candidate.task.deadline.slice(0, 10)}` : "";
    return `${heading}\n\n${candidate.task.title}\nStatus: ${candidate.task.status}\nPrioritas: ${candidate.task.priority}${deadline}`;
  }
}
