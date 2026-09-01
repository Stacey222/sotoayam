import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task } from "../tasks/types.js";
import type { DeliveryState, FailureClass, NotificationDelivery, NotificationEventType, NotificationIntent, NotificationRoutingRule, TaskReminderState } from "../reminders/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface DueDelivery extends NotificationDelivery {
  notification: NotificationIntent;
}

export interface ReminderTasksRepository { findCandidates(limit: number): Promise<Task[]> }
export interface ReminderStateRepository { findForTasks(taskIds: number[]): Promise<Map<number, TaskReminderState>> }
export interface ReminderNotificationsRepository {
  createIntent(input: { taskId: number; eventType: NotificationEventType; recipientUserId: number | null; routingFailureCode: string | null; dedupeKey: string; message: string; occurrenceAt: string; nextEligibleAt: string }): Promise<{ notificationId: number; created: boolean }>;
  findDue(now: string, staleBefore: string, limit: number): Promise<DueDelivery[]>;
  claim(delivery: DueDelivery): Promise<NotificationDelivery | null>;
  markDelivered(id: number, attemptCount: number, deliveredAt: string): Promise<void>;
  markFailed(id: number, input: { state: "PENDING" | "FAILED"; attemptCount: number; nextAttemptAt: string | null; failureClass: FailureClass; failureCode: string }): Promise<void>;
  status(): Promise<{ pending: number; processing: number; delivered: number; failed: number; unrouted_escalations: number }>;
  recent(limit: number): Promise<Array<{ id: number; task_id: number; event_type: NotificationEventType; routing_status: string; routing_failure_code: string | null; state: DeliveryState | "UNROUTED"; attempt_count: number; failure_class: FailureClass | null; failure_code: string | null; created_at: string }>>;
}
export interface ReminderRoutingRepository { findEscalationRule(ownerDivisionId: number, priority: Task["priority"]): Promise<NotificationRoutingRule | null> }
export interface ReminderChannel { userId: number; channel: "TELEGRAM"; externalId: string }
export interface ReminderChannelsRepository { findActiveTelegramForUser(userId: number): Promise<ReminderChannel[]> }
export interface SchedulerStateView { last_started_at: string | null; last_completed_at: string | null; last_status: "IDLE" | "RUNNING" | "COMPLETED" | "FAILED"; last_tasks_evaluated: number; last_candidates: number; last_notifications_created: number; last_deliveries_attempted: number; lease_until: string | null }
export interface ReminderSchedulerRepository {
  acquire(owner: string, leaseSeconds: number): Promise<boolean>;
  complete(owner: string, status: "COMPLETED" | "FAILED", result: { tasks: number; candidates: number; notifications: number; deliveries: number }): Promise<boolean>;
  status(): Promise<SchedulerStateView>;
}

export class SupabaseReminderTasksRepository implements ReminderTasksRepository {
  constructor(private readonly client: SupabaseClient) {}
  async findCandidates(limit: number): Promise<Task[]> {
    const { data, error } = await this.client.from("tasks").select("*").in("status", ["OPEN", "IN_PROGRESS", "BLOCKED"])
      .order("updated_at", { ascending: true }).limit(limit);
    if (error) throw governanceDatabaseError("Unable to load reminder task candidates", error);
    return (data ?? []) as Task[];
  }
}

export class SupabaseReminderStateRepository implements ReminderStateRepository {
  constructor(private readonly client: SupabaseClient) {}
  async findForTasks(taskIds: number[]): Promise<Map<number, TaskReminderState>> {
    if (taskIds.length === 0) return new Map();
    const { data, error } = await this.client.from("task_reminder_states").select("*").in("task_id", taskIds);
    if (error) throw governanceDatabaseError("Unable to load task reminder states", error);
    return new Map(((data ?? []) as TaskReminderState[]).map((row) => [row.task_id, row]));
  }
}

export class SupabaseReminderChannelsRepository implements ReminderChannelsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async findActiveTelegramForUser(userId: number): Promise<ReminderChannel[]> {
    const { data, error } = await this.client.from("user_channels").select("user_id,channel_type,external_id")
      .eq("user_id", userId).eq("channel_type", "TELEGRAM").eq("active", true).not("verified_at", "is", null).limit(2);
    if (error) throw governanceDatabaseError("Unable to resolve normalized notification channel", error);
    return (data ?? []).map((row) => ({ userId: Number(row.user_id), channel: "TELEGRAM", externalId: String(row.external_id) }));
  }
}

export class SupabaseReminderRoutingRepository implements ReminderRoutingRepository {
  constructor(private readonly client: SupabaseClient) {}
  async findEscalationRule(ownerDivisionId: number, priority: Task["priority"]): Promise<NotificationRoutingRule | null> {
    const { data, error } = await this.client.from("notification_routing_rules").select("*")
      .eq("event_type", "TASK_ESCALATION").eq("owner_division_id", ownerDivisionId).eq("channel", "TELEGRAM").eq("active", true).limit(2);
    if (error) throw governanceDatabaseError("Unable to resolve escalation routing", error);
    const rows = (data ?? []) as NotificationRoutingRule[];
    return rows.find((row) => row.priority === priority) ?? rows.find((row) => row.priority === null) ?? null;
  }
}

export class SupabaseReminderNotificationsRepository implements ReminderNotificationsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async createIntent(input: { taskId: number; eventType: NotificationEventType; recipientUserId: number | null; routingFailureCode: string | null; dedupeKey: string; message: string; occurrenceAt: string; nextEligibleAt: string }): Promise<{ notificationId: number; created: boolean }> {
    const { data, error } = await this.client.rpc("create_task_notification", {
      p_task_id: input.taskId, p_event_type: input.eventType, p_recipient_user_id: input.recipientUserId,
      p_routing_failure_code: input.routingFailureCode,
      p_dedupe_key: input.dedupeKey, p_message: input.message, p_occurrence_at: input.occurrenceAt,
      p_next_eligible_at: input.nextEligibleAt,
    }).single();
    if (error) throw governanceDatabaseError("Unable to create task notification", error);
    const row = data as unknown as { notification_id: number; created: boolean };
    return { notificationId: Number(row.notification_id), created: row.created };
  }
  async findDue(now: string, staleBefore: string, limit: number): Promise<DueDelivery[]> {
    const { data, error } = await this.client.from("notification_deliveries")
      .select("*,notification:notifications(*)").in("state", ["PENDING", "PROCESSING"])
      .lte("next_attempt_at", now).order("next_attempt_at", { ascending: true }).limit(limit);
    if (error) throw governanceDatabaseError("Unable to load due notification deliveries", error);
    return ((data ?? []) as unknown as DueDelivery[]).filter((row) => row.state === "PENDING" || row.updated_at <= staleBefore);
  }
  async claim(delivery: DueDelivery): Promise<NotificationDelivery | null> {
    const { data, error } = await this.client.from("notification_deliveries").update({ state: "PROCESSING" })
      .eq("id", delivery.id).eq("attempt_count", delivery.attempt_count).eq("state", delivery.state)
      .eq("updated_at", delivery.updated_at).select("*").maybeSingle();
    if (error) throw governanceDatabaseError("Unable to claim notification delivery", error);
    return data as NotificationDelivery | null;
  }
  async markDelivered(id: number, attemptCount: number, deliveredAt: string): Promise<void> {
    const { error } = await this.client.from("notification_deliveries").update({ state: "DELIVERED", attempt_count: attemptCount,
      next_attempt_at: null, delivered_at: deliveredAt, failure_class: null, failure_code: null }).eq("id", id);
    if (error) throw governanceDatabaseError("Unable to record notification delivery success", error);
  }
  async markFailed(id: number, input: { state: "PENDING" | "FAILED"; attemptCount: number; nextAttemptAt: string | null; failureClass: FailureClass; failureCode: string }): Promise<void> {
    const { error } = await this.client.from("notification_deliveries").update({ state: input.state, attempt_count: input.attemptCount,
      next_attempt_at: input.nextAttemptAt, delivered_at: null, failure_class: input.failureClass, failure_code: input.failureCode }).eq("id", id);
    if (error) throw governanceDatabaseError("Unable to record notification delivery failure", error);
  }
  async status() {
    const states: DeliveryState[] = ["PENDING", "PROCESSING", "DELIVERED", "FAILED"];
    const counts = await Promise.all(states.map((state) => this.client.from("notification_deliveries").select("id", { count: "exact", head: true }).eq("state", state)));
    if (counts.some((result) => result.error)) throw governanceDatabaseError("Unable to load notification status", counts.find((result) => result.error)!.error!);
    const unrouted = await this.client.from("notifications").select("id", { count: "exact", head: true }).eq("event_type", "TASK_ESCALATION").eq("routing_status", "UNROUTED");
    if (unrouted.error) throw governanceDatabaseError("Unable to load unrouted escalation count", unrouted.error);
    return { pending: counts[0]!.count ?? 0, processing: counts[1]!.count ?? 0, delivered: counts[2]!.count ?? 0,
      failed: counts[3]!.count ?? 0, unrouted_escalations: unrouted.count ?? 0 };
  }
  async recent(limit: number) {
    const { data, error } = await this.client.from("notifications").select("id,task_id,event_type,routing_status,routing_failure_code,created_at,notification_deliveries(state,attempt_count,failure_class,failure_code)")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw governanceDatabaseError("Unable to load recent notifications", error);
    return (data ?? []).map((row) => {
      const delivery = Array.isArray(row.notification_deliveries) ? row.notification_deliveries[0] : row.notification_deliveries;
      return { id: Number(row.id), task_id: Number(row.task_id), event_type: row.event_type as NotificationEventType,
        routing_status: String(row.routing_status), state: (delivery?.state ?? "UNROUTED") as DeliveryState | "UNROUTED",
        routing_failure_code: row.routing_failure_code ? String(row.routing_failure_code) : null,
        attempt_count: Number(delivery?.attempt_count ?? 0), failure_class: (delivery?.failure_class ?? null) as FailureClass | null,
        failure_code: delivery?.failure_code ? String(delivery.failure_code) : null, created_at: String(row.created_at) };
    });
  }
}

export class SupabaseReminderSchedulerRepository implements ReminderSchedulerRepository {
  constructor(private readonly client: SupabaseClient) {}
  async acquire(owner: string, leaseSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc("try_acquire_reminder_scheduler_lease", { p_owner: owner, p_lease_seconds: leaseSeconds });
    if (error) throw governanceDatabaseError("Unable to acquire reminder scheduler lease", error);
    return data === true;
  }
  async complete(owner: string, status: "COMPLETED" | "FAILED", result: { tasks: number; candidates: number; notifications: number; deliveries: number }): Promise<boolean> {
    const { data, error } = await this.client.rpc("complete_reminder_scheduler_run", { p_owner: owner, p_status: status,
      p_tasks_evaluated: result.tasks, p_candidates: result.candidates, p_notifications_created: result.notifications,
      p_deliveries_attempted: result.deliveries });
    if (error) throw governanceDatabaseError("Unable to complete reminder scheduler run", error);
    return data === true;
  }
  async status(): Promise<SchedulerStateView> {
    const { data, error } = await this.client.from("reminder_scheduler_state").select("last_started_at,last_completed_at,last_status,last_tasks_evaluated,last_candidates,last_notifications_created,last_deliveries_attempted,lease_until")
      .eq("singleton_key", "TASK_REMINDER").single();
    if (error) throw governanceDatabaseError("Unable to load reminder scheduler status", error);
    return data as SchedulerStateView;
  }
}
