import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config/env.js";
import { createSupabaseClient } from "../src/db/supabase.js";

const migrationPath = path.resolve(process.cwd(), "supabase/migrations/202608290005_create_division_collaboration_rules.sql");
const sql = await readFile(migrationPath, "utf8");
const repository = await readFile(path.resolve(process.cwd(), "src/repositories/division-collaboration.repository.ts"), "utf8");
const checks: Record<string, boolean> = {
  TABLE: sql.includes("create table public.division_collaboration_rules"),
  DIRECTIONAL: sql.includes("source_division_id") && sql.includes("target_division_id"),
  SOURCE_TARGET_DIFFER: sql.includes("source_division_id <> target_division_id"),
  ACTIVE_UNIQUE: sql.includes("division_collaboration_rules_active_unique") && sql.includes("where active"),
  RLS: sql.includes("alter table public.division_collaboration_rules enable row level security"),
  NO_PUBLIC_POLICIES: !/create\s+policy/i.test(sql),
  DEFAULT_DENY: sql.includes("Missing active relation means denied"),
  IDEMPOTENT_SEED: /on conflict[\s\S]*do nothing/i.test(sql),
  INACTIVE_ENDPOINTS_DENY: repository.includes("source_division.active")
    && repository.includes("target_division.active") && repository.includes("!inner(active)"),
  NON_DESTRUCTIVE: !/\b(?:drop\s+table|truncate|delete\s+from)\b/i.test(sql),
};

const client = createSupabaseClient(loadConfig());
const { error } = await client.from("division_collaboration_rules").select("id").limit(0);
const pending = error?.code === "PGRST205";
if (!pending) {
  checks.LIVE_SCHEMA = !error;
}

console.log("Sotoayam Division Collaboration Schema\n");
for (const [name, passed] of Object.entries(checks)) console.log(`${name} = ${passed ? "PASS" : "FAIL"}`);
console.log(`LIVE_STATE = ${pending ? "PENDING_MIGRATION" : error ? "FAIL" : "PASS"}`);
console.log(`MIGRATION_SHA256 = ${createHash("sha256").update(sql).digest("hex")}`);
const passed = Object.values(checks).every(Boolean) && (pending || !error);
console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
if (!passed) process.exitCode = 1;
