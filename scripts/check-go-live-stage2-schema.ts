import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSupabaseClient } from "../src/db/supabase.js";
import { loadSupabaseConfig } from "../src/config/env.js";

const file = path.resolve(process.cwd(), "supabase/migrations/202609020001_create_business_identity_and_integration_capabilities.sql");
const sql = await readFile(file, "utf8");
const schema = sql.split("create or replace function")[0] ?? sql;
const checks: Record<string, boolean> = {
  BUSINESS_CODE_NULLABLE: sql.includes("add column business_user_code text") && !sql.includes("add column business_user_code text not null"),
  BUSINESS_CODE_FORMAT: sql.includes("users_business_user_code_format_check") && sql.includes("business_user_code = upper(trim(business_user_code))"),
  BUSINESS_CODE_UNIQUE: sql.includes("users_business_user_code_uidx") && sql.includes("where business_user_code is not null"),
  NO_USER_BACKFILL: !/update\s+public\.users\s+set\s+business_user_code/i.test(schema),
  CAPABILITY_TABLE: sql.includes("create table public.integration_capabilities") && sql.includes("unique (integration_id, capability_code)"),
  SUPPORTED_CAPABILITY: sql.includes("capability_code = 'TASK_CREATE'"),
  DEFAULT_DENY: !/default\s+true/i.test(schema) && !/insert\s+into\s+public\.integration_capabilities/i.test(schema),
  RLS: sql.includes("alter table public.integration_capabilities enable row level security"),
  NO_PUBLIC_POLICIES: !/create\s+policy/i.test(sql),
  NO_INTEGRATION_SEED: !/insert\s+into\s+public\.task_source_integrations/i.test(schema),
  SERVICE_ONLY_ADMIN: ["update_business_user_code", "create_task_source_integration", "set_task_source_integration_active", "grant_integration_capability", "revoke_integration_capability"]
    .every((fn) => sql.includes(`grant execute on function public.${fn}`) && sql.includes(`revoke all on function public.${fn}`)),
  AUDIT: ["BUSINESS_USER_CODE_ASSIGNED", "BUSINESS_USER_CODE_CHANGED", "INTEGRATION_CAPABILITY_GRANTED", "INTEGRATION_CAPABILITY_REVOKED", "INTEGRATION_ACTIVATED", "INTEGRATION_DEACTIVATED"].every((event) => sql.includes(event)),
  NON_DESTRUCTIVE: !/\b(?:drop\s+table|truncate|delete\s+from)\b/i.test(sql),
};

const client = createSupabaseClient(loadSupabaseConfig());
const [users, capabilities, integrations] = await Promise.all([
  client.from("users").select("business_user_code").limit(0),
  client.from("integration_capabilities").select("id,integration_id,capability_code,revoked_at").limit(0),
  client.from("task_source_integrations").select("id,code,active").limit(0),
]);
const probes = [users, capabilities, integrations];
const pending = probes.some((result) => ["PGRST204", "PGRST205", "42703", "42P01"].includes(result.error?.code ?? ""));
const live = probes.every((result) => !result.error);

console.log("Gwens Go-Live Stage 2 Schema\n");
for (const [name, passed] of Object.entries(checks)) console.log(`${name} = ${passed ? "PASS" : "FAIL"}`);
console.log(`LIVE_STAGE2_SCHEMA = ${pending ? "PENDING_MIGRATION" : live ? "PASS" : "FAIL"}`);
console.log(`MIGRATION_SHA256 = ${createHash("sha256").update(sql).digest("hex")}`);
const passed = Object.values(checks).every(Boolean) && (pending || live);
console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
if (!passed) process.exitCode = 1;
