import type { SupabaseClient } from "@supabase/supabase-js";
import type { AlertEvaluatorState, AlertTaskSignal, CriticalAlert, CriticalAlertCandidate, FailedDeliverySignal, PersistedAlertSeverity, SchedulerSignal } from "../alerts/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface CriticalAlertSignalsRepository {
  findActiveTasks(): Promise<AlertTaskSignal[]>;
  findBlockedSince(taskIds: number[]): Promise<Map<number, string>>;
  findFailedDeliveries(): Promise<FailedDeliverySignal[]>;
  reminderSchedulerState(): Promise<SchedulerSignal>;
  failedDeliveryCount(): Promise<number>;
  activeIntegrationCount(): Promise<number>;
}

export interface CriticalAlertsRepository {
  acquire(owner: string, leaseSeconds: number): Promise<boolean>;
  upsert(candidate: CriticalAlertCandidate): Promise<CriticalAlert>;
  resolveMissing(owner: string, seenKeys: string[], evaluatedTypes: string[], at: string): Promise<number>;
  complete(owner: string, status: "COMPLETED" | "FAILED", result: { candidates: number; refreshed: number; resolved: number; errorCode?: string }): Promise<boolean>;
  listActive(severity?: PersistedAlertSeverity, limit?: number): Promise<CriticalAlert[]>;
  findById(id: number): Promise<CriticalAlert | null>;
  acknowledge(id: number, actorUserId: number): Promise<CriticalAlert>;
  evaluatorState(): Promise<AlertEvaluatorState>;
}

export class SupabaseCriticalAlertSignalsRepository implements CriticalAlertSignalsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async findActiveTasks(): Promise<AlertTaskSignal[]> {
    const { data, error } = await this.client.from("tasks")
      .select("id,title,status,priority,deadline,task_category,owner_division_id")
      .in("status", ["OPEN", "IN_PROGRESS", "BLOCKED"]);
    if (error) throw governanceDatabaseError("Unable to load critical task signals", error);
    return (data ?? []) as AlertTaskSignal[];
  }
  async findBlockedSince(taskIds: number[]): Promise<Map<number, string>> {
    if (!taskIds.length) return new Map();
    const { data, error } = await this.client.from("audit_logs").select("object_id,created_at")
      .eq("object_type", "TASK").eq("action", "TASK_STATUS_CHANGED")
      .contains("after_state", { status: "BLOCKED" }).in("object_id", taskIds.map(String))
      .order("created_at", { ascending: false });
    if (error) throw governanceDatabaseError("Unable to load canonical blocked transitions", error);
    const result = new Map<number, string>();
    for (const row of data ?? []) if (!result.has(Number(row.object_id))) result.set(Number(row.object_id), String(row.created_at));
    return result;
  }
  async findFailedDeliveries(): Promise<FailedDeliverySignal[]> {
    const { data, error } = await this.client.from("notification_deliveries")
      .select("id,attempt_count,max_attempts,failure_class,notification:notifications!inner(task_id,task:tasks!inner(owner_division_id))")
      .eq("state", "FAILED");
    if (error) throw governanceDatabaseError("Unable to load failed notification signals", error);
    return (data ?? []).map((row: any) => {
      const notification = Array.isArray(row.notification) ? row.notification[0] : row.notification;
      const task = Array.isArray(notification?.task) ? notification.task[0] : notification?.task;
      return { id: Number(row.id), attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts),
        failureClass: row.failure_class ?? null, taskId: Number(notification.task_id), ownerDivisionId: Number(task.owner_division_id) };
    });
  }
  async reminderSchedulerState(): Promise<SchedulerSignal> {
    const { data, error } = await this.client.from("reminder_scheduler_state")
      .select("last_status,last_started_at,last_completed_at,lease_until").eq("singleton_key", "TASK_REMINDER").single();
    if (error) throw governanceDatabaseError("Unable to load reminder scheduler signal", error);
    return data as SchedulerSignal;
  }
  async failedDeliveryCount(): Promise<number> {
    const { count, error } = await this.client.from("notification_deliveries").select("id", { count: "exact", head: true }).eq("state", "FAILED");
    if (error) throw governanceDatabaseError("Unable to count failed notification deliveries", error);
    return count ?? 0;
  }
  async activeIntegrationCount(): Promise<number> {
    const { count, error } = await this.client.from("task_source_integrations").select("id", { count: "exact", head: true }).eq("active", true);
    if (error) throw governanceDatabaseError("Unable to count active integrations", error);
    return count ?? 0;
  }
}

export class SupabaseCriticalAlertsRepository implements CriticalAlertsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async acquire(owner: string, leaseSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc("try_acquire_critical_alert_lease", { p_owner: owner, p_lease_seconds: leaseSeconds });
    if (error) throw governanceDatabaseError("Unable to acquire critical alert lease", error);
    return data === true;
  }
  async upsert(candidate: CriticalAlertCandidate): Promise<CriticalAlert> {
    const { data, error } = await this.client.rpc("upsert_critical_alert", {
      p_alert_type: candidate.alertType, p_severity: candidate.severity, p_source_type: candidate.sourceType,
      p_source_reference: candidate.sourceReference, p_owner_division_id: candidate.ownerDivisionId,
      p_task_id: candidate.taskId, p_dimensions: candidate.dimensions, p_detected_at: candidate.detectedAt,
      p_dedupe_key: candidate.dedupeKey, p_summary: candidate.summary, p_safe_context: candidate.safeContext,
    });
    if (error) throw governanceDatabaseError("Unable to persist critical alert", error);
    return data as CriticalAlert;
  }
  async resolveMissing(owner: string, seenKeys: string[], evaluatedTypes: string[], at: string): Promise<number> {
    const { data, error } = await this.client.rpc("resolve_stale_critical_alerts", { p_owner: owner, p_seen_dedupe_keys: seenKeys, p_evaluated_types: evaluatedTypes, p_resolved_at: at });
    if (error) throw governanceDatabaseError("Unable to resolve stale critical alerts", error);
    return Number(data ?? 0);
  }
  async complete(owner: string, status: "COMPLETED" | "FAILED", result: { candidates: number; refreshed: number; resolved: number; errorCode?: string }): Promise<boolean> {
    const { data, error } = await this.client.rpc("complete_critical_alert_run", { p_owner: owner, p_status: status,
      p_candidates: result.candidates, p_refreshed: result.refreshed, p_resolved: result.resolved, p_error_code: result.errorCode ?? null });
    if (error) throw governanceDatabaseError("Unable to complete critical alert run", error);
    return data === true;
  }
  async listActive(severity?: PersistedAlertSeverity, limit = 20): Promise<CriticalAlert[]> {
    let query = this.client.from("critical_alerts").select("*").in("status", ["OPEN", "ACKNOWLEDGED"])
      .order("last_detected_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 50));
    if (severity) query = query.eq("severity", severity);
    const { data, error } = await query;
    if (error) throw governanceDatabaseError("Unable to list critical alerts", error);
    return (data ?? []) as CriticalAlert[];
  }
  async findById(id: number): Promise<CriticalAlert | null> {
    const { data, error } = await this.client.from("critical_alerts").select("*").eq("id", id).maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load critical alert", error);
    return data as CriticalAlert | null;
  }
  async acknowledge(id: number, actorUserId: number): Promise<CriticalAlert> {
    const { data, error } = await this.client.rpc("acknowledge_critical_alert", { p_alert_id: id, p_actor_user_id: actorUserId });
    if (error) throw governanceDatabaseError("Unable to acknowledge critical alert", error);
    return data as CriticalAlert;
  }
  async evaluatorState(): Promise<AlertEvaluatorState> {
    const { data, error } = await this.client.from("critical_alert_evaluator_state")
      .select("last_status,last_started_at,last_completed_at,lease_until,last_candidates,last_alerts_refreshed,last_alerts_resolved,last_error_code")
      .eq("singleton_key", "CRITICAL_ALERT").single();
    if (error) throw governanceDatabaseError("Unable to load critical alert evaluator state", error);
    return data as AlertEvaluatorState;
  }
}
