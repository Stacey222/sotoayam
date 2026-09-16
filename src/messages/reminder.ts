import type { NotificationEventType } from "../reminders/types.js";

export interface ReminderMessageInput {
  eventType: NotificationEventType;
  title: string;
  status: string;
  priority: string;
  deadline: string | null;
}

export function formatReminderMessage(input: ReminderMessageInput): string {
  const heading = input.eventType === "TASK_ESCALATION" ? "Eskalasi tugas" : "Pengingat tugas";
  const deadline = input.deadline ? `\nDeadline: ${input.deadline.slice(0, 10)}` : "";
  return `${heading}\n\n${input.title}\nStatus: ${input.status}\nPrioritas: ${input.priority}${deadline}`;
}
