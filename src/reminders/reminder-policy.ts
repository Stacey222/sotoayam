import type { ReminderCandidate, ReminderPolicyConfig, TaskReminderState } from "./types.js";
import type { Task } from "../tasks/types.js";

export const DEFAULT_REMINDER_POLICY: ReminderPolicyConfig = {
  approachHours: { LOW: 24, NORMAL: 24, HIGH: 48, URGENT: 72 },
  repeatHours: { LOW: 24, NORMAL: 12, HIGH: 6, URGENT: 2 },
  blockedHours: 24,
  escalationReminderCount: 3,
  escalationOverdueHours: 48,
  escalationBlockedHours: 48,
};

export class TaskReminderPolicy {
  constructor(private readonly config: ReminderPolicyConfig = DEFAULT_REMINDER_POLICY) {}

  evaluate(task: Task, state: TaskReminderState | null, now: Date): ReminderCandidate[] {
    if (task.status === "COMPLETED" || task.status === "CANCELLED" || task.status === "DRAFT") return [];
    const result: ReminderCandidate[] = [];
    const deadline = task.deadline ? new Date(task.deadline) : null;
    const overdueHours = deadline ? (now.getTime() - deadline.getTime()) / 3_600_000 : -1;
    const blockedHours = task.status === "BLOCKED" ? (now.getTime() - new Date(task.updated_at).getTime()) / 3_600_000 : -1;
    const reminderReady = !state?.next_reminder_at || new Date(state.next_reminder_at) <= now;
    let reminderReason: ReminderCandidate["reason"] | null = null;
    if (reminderReady && overdueHours > 0) reminderReason = "OVERDUE";
    else if (reminderReady && blockedHours >= this.config.blockedHours) reminderReason = "BLOCKED";
    else if (reminderReady && deadline && ["OPEN", "IN_PROGRESS"].includes(task.status)
      && deadline.getTime() >= now.getTime()
      && deadline.getTime() - now.getTime() <= this.config.approachHours[task.priority] * 3_600_000) reminderReason = "APPROACHING_DEADLINE";
    if (reminderReason) result.push(this.candidate(task, "TASK_REMINDER", reminderReason, now, this.config.repeatHours[task.priority]));

    const escalationReady = !state?.next_escalation_at || new Date(state.next_escalation_at) <= now;
    const escalate = escalationReady && (
      (state?.reminder_count ?? 0) >= this.config.escalationReminderCount
      || overdueHours >= this.config.escalationOverdueHours
      || blockedHours >= this.config.escalationBlockedHours
    );
    if (escalate) result.push(this.candidate(task, "TASK_ESCALATION",
      (state?.reminder_count ?? 0) >= this.config.escalationReminderCount ? "REMINDER_THRESHOLD" : overdueHours >= this.config.escalationOverdueHours ? "OVERDUE" : "BLOCKED",
      now, 24));
    return result;
  }

  private candidate(task: Task, eventType: ReminderCandidate["eventType"], reason: ReminderCandidate["reason"], now: Date, intervalHours: number): ReminderCandidate {
    const interval = intervalHours * 3_600_000;
    return { task, eventType, reason, occurrenceAt: new Date(Math.floor(now.getTime() / interval) * interval),
      nextEligibleAt: new Date(now.getTime() + interval) };
  }
}
