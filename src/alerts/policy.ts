import type { AlertSeverity } from "./types.js";
import type { TaskPriority } from "../tasks/types.js";

export interface CriticalAlertPolicy {
  overdue: { warningHours: number; highHours: number; criticalHours: number };
  blocked: { warningHours: number; highHours: number; criticalHours: number };
  scheduler: { staleMinutes: number; criticalMinutes: number };
}

export const DEFAULT_CRITICAL_ALERT_POLICY: CriticalAlertPolicy = {
  overdue: { warningHours: 1, highHours: 24, criticalHours: 72 },
  blocked: { warningHours: 4, highHours: 24, criticalHours: 72 },
  scheduler: { staleMinutes: 15, criticalMinutes: 60 },
};

const positive = (value: unknown, name: string): number => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 8760) throw new Error(`Invalid critical alert policy: ${name}`);
  return Number(value);
};
const duration = (value: unknown, defaults: { warningHours: number; highHours: number; criticalHours: number }, name: string) => {
  if (value === undefined) return defaults;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid critical alert policy: ${name}`);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["warningHours", "highHours", "criticalHours"].includes(key))) throw new Error(`Invalid critical alert policy key: ${name}`);
  const result = { warningHours: positive(item.warningHours, `${name}.warningHours`), highHours: positive(item.highHours, `${name}.highHours`), criticalHours: positive(item.criticalHours, `${name}.criticalHours`) };
  if (!(result.warningHours < result.highHours && result.highHours < result.criticalHours)) throw new Error(`Invalid critical alert policy ordering: ${name}`);
  return result;
};

export function parseCriticalAlertPolicy(raw: string | undefined): CriticalAlertPolicy {
  if (!raw?.trim()) return DEFAULT_CRITICAL_ALERT_POLICY;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid environment variable: CRITICAL_ALERT_POLICY_JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid environment variable: CRITICAL_ALERT_POLICY_JSON");
  const item = parsed as Record<string, unknown>;
  const unknown = Object.keys(item).filter((key) => !["overdue", "blocked", "scheduler"].includes(key));
  if (unknown.length) throw new Error("Invalid critical alert policy key");
  let scheduler = DEFAULT_CRITICAL_ALERT_POLICY.scheduler;
  if (item.scheduler !== undefined) {
    if (!item.scheduler || typeof item.scheduler !== "object" || Array.isArray(item.scheduler)) throw new Error("Invalid critical alert policy: scheduler");
    const value = item.scheduler as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["staleMinutes", "criticalMinutes"].includes(key))) throw new Error("Invalid critical alert policy key: scheduler");
    scheduler = { staleMinutes: positive(value.staleMinutes, "scheduler.staleMinutes"), criticalMinutes: positive(value.criticalMinutes, "scheduler.criticalMinutes") };
    if (scheduler.staleMinutes >= scheduler.criticalMinutes) throw new Error("Invalid critical alert policy ordering: scheduler");
  }
  return { overdue: duration(item.overdue, DEFAULT_CRITICAL_ALERT_POLICY.overdue, "overdue"), blocked: duration(item.blocked, DEFAULT_CRITICAL_ALERT_POLICY.blocked, "blocked"), scheduler };
}

const ORDER: AlertSeverity[] = ["NORMAL", "WARNING", "HIGH", "CRITICAL"];
export function durationSeverity(hours: number, thresholds: { warningHours: number; highHours: number; criticalHours: number }, priority?: TaskPriority): AlertSeverity {
  let index = hours >= thresholds.criticalHours ? 3 : hours >= thresholds.highHours ? 2 : hours >= thresholds.warningHours ? 1 : 0;
  if (index > 0 && (priority === "HIGH" || priority === "URGENT")) index = Math.min(3, index + 1);
  return ORDER[index]!;
}
