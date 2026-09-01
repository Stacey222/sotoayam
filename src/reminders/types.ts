import type { Task, TaskPriority } from "../tasks/types.js";

export type NotificationEventType = "TASK_REMINDER" | "TASK_ESCALATION";
export type NotificationChannel = "TELEGRAM" | "WHATSAPP" | "EMAIL";
export type DeliveryState = "PENDING" | "PROCESSING" | "DELIVERED" | "FAILED" | "CANCELLED";
export type FailureClass = "TRANSIENT" | "PERMANENT";

export interface TaskReminderState {
  task_id: number; last_reminder_at: string | null; next_reminder_at: string | null; reminder_count: number;
  last_escalation_at: string | null; next_escalation_at: string | null; escalation_count: number;
  last_evaluated_at: string; created_at: string; updated_at: string;
}

export interface NotificationIntent {
  id: number; task_id: number; event_type: NotificationEventType; recipient_user_id: number | null;
  routing_status: "ROUTED" | "UNROUTED"; dedupe_key: string; message: string;
  routing_failure_code: string | null;
  occurrence_at: string; created_at: string;
}

export interface NotificationDelivery {
  id: number; notification_id: number; channel: NotificationChannel; state: DeliveryState;
  attempt_count: number; max_attempts: number; scheduled_at: string; next_attempt_at: string | null;
  delivered_at: string | null; failure_class: FailureClass | null; failure_code: string | null;
  created_at: string; updated_at: string;
}

export interface NotificationRoutingRule {
  id: number; event_type: "TASK_ESCALATION"; owner_division_id: number; priority: TaskPriority | null;
  recipient_strategy: "SPECIFIC_USER"; recipient_user_id: number; channel: NotificationChannel;
  active: boolean; created_at: string; updated_at: string;
}

export interface ReminderCandidate {
  task: Task; eventType: NotificationEventType; occurrenceAt: Date; nextEligibleAt: Date;
  reason: "APPROACHING_DEADLINE" | "OVERDUE" | "BLOCKED" | "REMINDER_THRESHOLD";
}

export interface ReminderEvaluationResult {
  dry_run: boolean; tasks_evaluated: number; reminder_candidates: number;
  escalation_candidates: number; notifications_created: number; unrouted: number;
  would_create_notifications: number; unrouted_escalations: number;
  deliveries_attempted: number; delivered: number; failed: number; skipped_locked: boolean;
}

export interface ReminderPolicyConfig {
  approachHours: Record<TaskPriority, number>;
  repeatHours: Record<TaskPriority, number>;
  blockedHours: number; escalationReminderCount: number; escalationOverdueHours: number; escalationBlockedHours: number;
}
