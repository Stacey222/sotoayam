import type { TaskPriority } from "../tasks/types.js";

export const ALERT_TYPES = ["TASK_OVERDUE", "TASK_BLOCKED_TOO_LONG", "NOTIFICATION_DELIVERY_FAILURE", "REMINDER_SCHEDULER_UNHEALTHY"] as const;
export const ALERT_SEVERITIES = ["NORMAL", "WARNING", "HIGH", "CRITICAL"] as const;
export const PERSISTED_ALERT_SEVERITIES = ["WARNING", "HIGH", "CRITICAL"] as const;
export const ALERT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const;
export const ALERT_DIMENSIONS = ["VALUE", "BASELINE", "DURATION", "BUSINESS_IMPACT"] as const;
export type AlertType = typeof ALERT_TYPES[number];
export type AlertSeverity = typeof ALERT_SEVERITIES[number];
export type PersistedAlertSeverity = typeof PERSISTED_ALERT_SEVERITIES[number];
export type AlertStatus = typeof ALERT_STATUSES[number];
export type AlertDimension = typeof ALERT_DIMENSIONS[number];
export type AlertSourceType = "TASK" | "NOTIFICATION_DELIVERY" | "REMINDER_SCHEDULER";

export interface CriticalAlertCandidate {
  alertType: AlertType;
  severity: AlertSeverity;
  sourceType: AlertSourceType;
  sourceReference: string;
  ownerDivisionId: number | null;
  taskId: number | null;
  dimensions: AlertDimension[];
  detectedAt: string;
  dedupeKey: string;
  summary: string;
  safeContext: Record<string, string | number | boolean | null>;
}

export interface CriticalAlert {
  id: number;
  alert_type: AlertType;
  severity: PersistedAlertSeverity;
  source_type: AlertSourceType;
  source_reference: string;
  owner_division_id: number | null;
  task_id: number | null;
  status: AlertStatus;
  dimensions: AlertDimension[];
  first_detected_at: string;
  last_detected_at: string;
  occurrence_count: number;
  dedupe_key: string;
  acknowledged_at: string | null;
  acknowledged_by_user_id: number | null;
  resolved_at: string | null;
  summary: string;
  safe_context: Record<string, string | number | boolean | null>;
  created_at: string;
  updated_at: string;
}

export interface AlertTaskSignal {
  id: number; title: string; status: string; priority: TaskPriority; deadline: string | null;
  task_category: string | null; owner_division_id: number;
}
export interface FailedDeliverySignal {
  id: number; attemptCount: number; maxAttempts: number; failureClass: "TRANSIENT" | "PERMANENT" | null;
  taskId: number; ownerDivisionId: number;
}
export interface SchedulerSignal {
  last_status: "IDLE" | "RUNNING" | "COMPLETED" | "FAILED";
  last_started_at: string | null; last_completed_at: string | null; lease_until: string | null;
}
export interface AlertEvaluatorState extends SchedulerSignal {
  last_candidates: number; last_alerts_refreshed: number; last_alerts_resolved: number; last_error_code: string | null;
}

export interface AlertEvaluationResult {
  dryRun: boolean; skippedLocked: boolean; observations: CriticalAlertCandidate[];
  candidates: number; alertsRefreshed: number; alertsResolved: number;
}

export interface AutomationStatus {
  overall: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  runtime: "HEALTHY";
  telegramPolling: "HEALTHY" | "DEGRADED";
  reminderScheduler: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  criticalAlertEvaluator: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  notificationDelivery: "HEALTHY" | "DEGRADED";
  activeIntegrations: number;
}
