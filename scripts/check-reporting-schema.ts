import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSupabaseClient } from "../src/db/supabase.js";
import { loadSupabaseConfig } from "../src/config/env.js";

const file = path.resolve(process.cwd(), "supabase/migrations/202609010003_add_task_category.sql");
const sql = await readFile(file, "utf8");
const checks: Record<string, boolean> = {
  ADDITIVE_CATEGORY: sql.includes("add column task_category text"),
  EXTENSIBLE_CODE: sql.includes("task_category ~ '^[A-Z][A-Z0-9_]{0,49}$'"),
  NULLABLE_NO_BACKFILL: !/task_category\s+text\s+not\s+null/i.test(sql) && !/update\s+public\.tasks/i.test(sql),
  REPORTING_INDEX: sql.includes("tasks_reporting_category_idx") && sql.includes("owner_division_id, task_category, created_at desc"),
  NON_DESTRUCTIVE: !/\b(?:drop|truncate|delete\s+from)\b/i.test(sql),
  NO_PUBLIC_POLICIES: !/create\s+policy|disable\s+row\s+level/i.test(sql),
  NO_SPECULATIVE_CATEGORY: !sql.includes("AFFILIATE"),
};
const client = createSupabaseClient(loadSupabaseConfig());
const probe = await client.from("tasks").select("task_category").limit(0);
const pending = ["PGRST204", "42703"].includes(probe.error?.code ?? "");
const live = !probe.error;
console.log("Sotoayam Reporting Foundation Schema\n");
for (const [name, passed] of Object.entries(checks)) console.log(`${name} = ${passed ? "PASS" : "FAIL"}`);
console.log(`LIVE_REPORTING_SCHEMA = ${pending ? "PENDING_MIGRATION" : live ? "PASS" : "FAIL"}`);
console.log(`MIGRATION_SHA256 = ${createHash("sha256").update(sql).digest("hex")}`);
const passed = Object.values(checks).every(Boolean) && (pending || live);
console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
if (!passed) process.exitCode = 1;
