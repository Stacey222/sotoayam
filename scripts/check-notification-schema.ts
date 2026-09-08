import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSupabaseClient } from "../src/db/supabase.js";
import { loadSupabaseConfig } from "../src/config/env.js";

const file = path.resolve(process.cwd(), "supabase/migrations/202609010002_create_task_notification_foundation.sql");
const sql = await readFile(file, "utf8");
const intakeFile = path.resolve(process.cwd(), "supabase/migrations/202609080001_create_notification_event_intake.sql");
const intakeSql = await readFile(intakeFile, "utf8");
const tables = ["notifications", "notification_deliveries", "task_reminder_states", "notification_routing_rules", "reminder_scheduler_state"];
const checks: Record<string, boolean> = {
  TABLES: tables.every((table) => sql.includes(`create table public.${table}`)),
  DELIVERY_STATES: ["PENDING", "PROCESSING", "DELIVERED", "FAILED", "CANCELLED"].every((state) => sql.includes(`'${state}'`)),
  DURABLE_DEDUPE: sql.includes("dedupe_key text not null unique"),
  DURABLE_REMINDER_STATE: ["last_reminder_at", "next_reminder_at", "reminder_count"].every((field) => sql.includes(field)),
  BOUNDED_RETRY: sql.includes("max_attempts") && sql.includes("attempt_count between 0 and 5"),
  UNROUTED_ESCALATION: sql.includes("ESCALATION_UNROUTED"),
  OVERLAP_PROTECTION: sql.includes("pg_advisory_xact_lock") && sql.includes("try_acquire_reminder_scheduler_lease"),
  ATOMIC_INTENT: sql.includes("create_task_notification") && sql.includes("REMINDER_INTENT_GENERATED"),
  RLS: tables.every((table) => sql.includes(`alter table public.${table} enable row level security`)),
  NO_PUBLIC_POLICIES: !/create\s+policy/i.test(sql),
  NO_SPECULATIVE_ROUTES: !/insert\s+into\s+public\.notification_routing_rules/i.test(sql),
  LEGACY_UNCHANGED: !/alter\s+table\s+public\.telegram_users/i.test(sql),
  NON_DESTRUCTIVE: !/\b(?:drop\s+table|truncate|delete\s+from)\b/i.test(sql),
  EVENT_INTENT_TABLE: intakeSql.includes("create table public.notification_events"),
  EVENT_IDENTITY_UNIQUE: intakeSql.includes("constraint notification_events_identity_uidx unique (source, external_event_id)"),
  EVENT_PARENT_INTEGRITY: intakeSql.includes("constraint notifications_single_parent"),
  EVENT_ATOMIC_EXPANSION: intakeSql.includes("create or replace function public.intake_notification_event")
    && intakeSql.includes("on conflict on constraint notification_events_identity_uidx")
    && intakeSql.includes("do update set external_event_id = excluded.external_event_id"),
  EVENT_RLS: intakeSql.includes("alter table public.notification_events enable row level security"),
  EVENT_NO_PUBLIC_POLICIES: !/create\s+policy/i.test(intakeSql),
  EVENT_RPC_HARDENED: intakeSql.includes("security definer")
    && intakeSql.includes("set search_path = ''")
    && intakeSql.includes("from public, anon, authenticated")
    && intakeSql.includes("to service_role"),
  EVENT_METADATA_NOT_STORED: !/\bmetadata\s+(?:json|jsonb|text)\b/i.test(intakeSql),
  DELIVERY_TABLE_UNCHANGED: !/alter\s+table\s+public\.notification_deliveries/i.test(intakeSql),
  EVENT_NON_DESTRUCTIVE: !/\b(?:drop\s+table|truncate|delete\s+from)\b/i.test(intakeSql),
};
const client = createSupabaseClient(loadSupabaseConfig());
const probes = await Promise.all([
  client.from("notifications").select("id,task_id,event_type,routing_status,routing_failure_code,dedupe_key").limit(0),
  client.from("notification_deliveries").select("id,notification_id,channel,state,attempt_count,max_attempts,next_attempt_at").limit(0),
  client.from("task_reminder_states").select("task_id,last_reminder_at,next_reminder_at,reminder_count").limit(0),
  client.from("notification_routing_rules").select("id,event_type,owner_division_id,recipient_user_id,channel,active").limit(0),
  client.from("reminder_scheduler_state").select("singleton_key,last_status,last_started_at,last_completed_at").limit(0),
  client.from("notification_events").select("id,source,external_event_id,identity_origin,event_type,recipient_count,routed_count,dispatched_at").limit(0),
  client.from("notifications").select("id,task_id,notification_event_id,event_type").limit(0),
]);
const pending = probes.some((result) => ["PGRST205", "PGRST204", "42703"].includes(result.error?.code ?? ""));
const live = probes.every((result) => !result.error);
const compatible = probes.every((result) => !result.error || ["PGRST205", "PGRST204", "42703"].includes(result.error.code ?? ""));
console.log("Sotoayam Notification Foundation Schema\n");
for (const [name, passed] of Object.entries(checks)) console.log(`${name} = ${passed ? "PASS" : "FAIL"}`);
console.log(`LIVE_NOTIFICATION_SCHEMA = ${pending ? "PENDING_MIGRATION" : live ? "PASS" : "FAIL"}`);
console.log(`MIGRATION_SHA256 = ${createHash("sha256").update(sql + intakeSql).digest("hex")}`);
const passed = Object.values(checks).every(Boolean) && compatible && (pending || live);
console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
if (!passed) process.exitCode = 1;
