import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSupabaseClient } from "../src/db/supabase.js";
import { loadSupabaseConfig } from "../src/config/env.js";

const file = path.resolve("supabase/migrations/202609010004_create_critical_alert_foundation.sql");
const sql = await readFile(file, "utf8");
const checks: Record<string, boolean> = {
  ALERT_DOMAIN: ["critical_alerts", "alert_type", "severity", "source_reference", "occurrence_count", "acknowledged_at", "resolved_at", "safe_context"].every((item) => sql.includes(item)),
  CONFIRMED_TYPES: ["TASK_OVERDUE", "TASK_BLOCKED_TOO_LONG", "NOTIFICATION_DELIVERY_FAILURE", "REMINDER_SCHEDULER_UNHEALTHY"].every((item) => sql.includes(`'${item}'`)),
  DURABLE_DEDUPE: sql.includes("critical_alerts_active_dedupe_uidx") && sql.includes("on conflict (dedupe_key)"),
  LIFECYCLE: ["OPEN", "ACKNOWLEDGED", "RESOLVED"].every((item) => sql.includes(`'${item}'`)),
  OVERLAP_PROTECTION: sql.includes("pg_advisory_xact_lock") && sql.includes("try_acquire_critical_alert_lease"),
  ACK_OWNER_GUARD: sql.includes("roles.code = 'OWNER'") && sql.includes("users.active"),
  AUDIT: ["CRITICAL_ALERT_OPENED", "CRITICAL_ALERT_RESOLVED", "CRITICAL_ALERT_ACKNOWLEDGED"].every((item) => sql.includes(item)),
  RLS: ["critical_alerts", "critical_alert_evaluator_state"].every((table) => sql.includes(`alter table public.${table} enable row level security`)),
  NO_PUBLIC_POLICIES: !/create\s+policy/i.test(sql),
  TASK_LIFECYCLE_UNCHANGED: !/update\s+public\.tasks/i.test(sql),
  NON_DESTRUCTIVE: !/\b(?:drop\s+table|truncate|delete\s+from)\b/i.test(sql),
};
const client = createSupabaseClient(loadSupabaseConfig());
const probes = await Promise.all([
  client.from("critical_alerts").select("id,alert_type,severity,status,dedupe_key,acknowledged_at,resolved_at").limit(0),
  client.from("critical_alert_evaluator_state").select("singleton_key,last_status,last_completed_at,last_candidates").limit(0),
]);
const pending = probes.some((result) => ["PGRST205", "PGRST204", "42P01", "42703"].includes(result.error?.code ?? ""));
const live = probes.every((result) => !result.error);
console.log("Sotoayam Critical Alert Foundation Schema\n");
for (const [name, passed] of Object.entries(checks)) console.log(`${name} = ${passed ? "PASS" : "FAIL"}`);
console.log(`LIVE_CRITICAL_ALERT_SCHEMA = ${pending ? "PENDING_MIGRATION" : live ? "PASS" : "FAIL"}`);
console.log(`MIGRATION_SHA256 = ${createHash("sha256").update(sql).digest("hex")}`);
const passed = Object.values(checks).every(Boolean) && (pending || live);
console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
if (!passed) process.exitCode = 1;
