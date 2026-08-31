import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createSupabaseClient } from "../src/db/supabase.js";
import { loadConfig } from "../src/config/env.js";
import { buildApp } from "../src/app.js";

const file = path.resolve(process.cwd(), "supabase/migrations/202608290004_create_task_core.sql");
const sql = await readFile(file, "utf8");
const tables = ["tasks", "task_activities", "task_relationships"];
const checks: Record<string, boolean> = {
  TABLES: tables.every((table) => sql.includes(`create table public.${table}`)),
  RLS: tables.every((table) => sql.includes(`alter table public.${table} enable row level security`)),
  NO_PUBLIC_POLICIES: !/create\s+policy/i.test(sql),
  NON_DESTRUCTIVE: !/\b(?:drop\s+table|truncate|delete\s+from)\b/i.test(sql),
  TASK_STATUS_BOUNDED: ["DRAFT", "OPEN", "IN_PROGRESS", "BLOCKED", "COMPLETED", "CANCELLED"].every((value) => sql.includes(`'${value}'`)),
  OVERDUE_NOT_STORED: !/['"]OVERDUE['"]/.test(sql) && sql.includes("OVERDUE is derived"),
  NORMALIZED_OWNERSHIP: sql.includes("created_by_user_id bigint not null references public.users") && sql.includes("assigned_to_user_id bigint references public.users"),
  DIVISION_OWNERSHIP: sql.includes("requesting_division_id") && sql.includes("owner_division_id"),
  ACTIVITY_EVIDENCE: sql.includes("evidence_type") && sql.includes("evidence_reference"),
  RELATIONSHIP_INTEGRITY: sql.includes("source_task_id <> target_task_id") && sql.includes("unique (source_task_id, target_task_id, relationship_type)"),
};

const config = loadConfig();
const client = createSupabaseClient(config);
const results = await Promise.all(tables.map((table) => client.from(table).select("id", { count: "exact" }).limit(1)));
const pending = results.some((result) => result.error?.code === "PGRST205");
const live = results.every((result) => !result.error);
const taskCount = results[0]?.count ?? 0;
const { app } = await buildApp({ config, logger: false });
try {
  const denied = await app.inject({ method: "GET", url: "/api/tasks" });
  checks.API_PROTECTED = Boolean(config.adminApiKey) && denied.statusCode === 401;
  if (live) {
    const accepted = await app.inject({ method: "GET", url: "/api/tasks", headers: { "x-admin-api-key": config.adminApiKey ?? "" } });
    checks.LIVE_TASK_API = accepted.statusCode === 200 && Array.isArray(accepted.json().data);
  }
} finally { await app.close(); }

console.log("Gwens Task Core Schema\n");
for (const [name, value] of Object.entries(checks)) console.log(`${name} = ${value ? "PASS" : "FAIL"}`);
console.log(`LIVE_TASK_SCHEMA = ${pending ? "PENDING_MIGRATION" : live ? "PASS" : "FAIL"}`);
console.log(`PRODUCTION_TASK_COUNT = ${taskCount}`);
console.log(`MIGRATION_SHA256 = ${createHash("sha256").update(sql).digest("hex")}`);
const passed = Object.values(checks).every(Boolean) && (pending || live);
console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
if (!passed) process.exitCode = 1;
