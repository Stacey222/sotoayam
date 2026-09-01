import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSupabaseClient } from "../src/db/supabase.js";
import { loadSupabaseConfig } from "../src/config/env.js";

const file = path.resolve(process.cwd(), "supabase/migrations/202609010001_create_task_ingestion_foundation.sql");
const sql = await readFile(file, "utf8");
const checks: Record<string, boolean> = {
  ADDITIVE_TABLES: ["task_source_integrations", "task_import_batches"].every((table) => sql.includes(`create table public.${table}`)),
  TASK_ORIGIN: sql.includes("tasks_exactly_one_origin_check") && sql.includes("integration_id") && sql.includes("import_batch_id"),
  DURABLE_IDEMPOTENCY: sql.includes("tasks_human_external_reference_uidx") && sql.includes("tasks_integration_external_reference_uidx"),
  RLS: ["task_source_integrations", "task_import_batches"].every((table) => sql.includes(`alter table public.${table} enable row level security`)),
  NO_PUBLIC_POLICIES: !/create\s+policy/i.test(sql),
  NON_DESTRUCTIVE: !/\b(?:drop\s+table|truncate|delete\s+from)\b/i.test(sql),
  NO_INTEGRATION_SEED: !/insert\s+into\s+public\.task_source_integrations/i.test(sql),
};

const client = createSupabaseClient(loadSupabaseConfig());
const probes = await Promise.all([
  client.from("task_source_integrations").select("id,code,source,requesting_division_id,active").limit(0),
  client.from("task_import_batches").select("id,context,source,initiated_by_user_id,integration_id,dry_run,status,total_rows,created_rows,failed_rows").limit(0),
  client.from("tasks").select("id,created_by_user_id,integration_id,import_batch_id,source_reference").limit(0),
]);
const pending = probes.some((result) => result.error?.code === "PGRST205" || result.error?.code === "PGRST204" || result.error?.code === "42703");
const live = probes.every((result) => !result.error);

console.log("Gwens Task Ingestion Schema\n");
for (const [name, passed] of Object.entries(checks)) console.log(`${name} = ${passed ? "PASS" : "FAIL"}`);
console.log(`LIVE_INGESTION_SCHEMA = ${pending ? "PENDING_MIGRATION" : live ? "PASS" : "FAIL"}`);
console.log(`MIGRATION_SHA256 = ${createHash("sha256").update(sql).digest("hex")}`);
const passed = Object.values(checks).every(Boolean) && (pending || live);
console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
if (!passed) process.exitCode = 1;
