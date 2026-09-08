import { readFile } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { loadSupabaseConfig } from "../src/config/env.js";
import { createSupabaseClient } from "../src/db/supabase.js";

const MIGRATION = "202609090001_create_first_admin_bootstrap.sql";

async function main(): Promise<void> {
  console.log("Sotoayam First Administrator Bootstrap\n");
  const sql = await readFile(path.resolve(process.cwd(), "supabase/migrations", MIGRATION), "utf8");
  const lowerSql = sql.toLowerCase();
  const functionBlock = lowerSql.split("create or replace function public.bootstrap_first_admin")[1] ?? "";
  const checks = {
    SERVICE_ONLY_RPC: lowerSql.includes("revoke all on function public.bootstrap_first_admin(text, text, text, text)\n  from public, anon, authenticated")
      && lowerSql.includes("grant execute on function public.bootstrap_first_admin(text, text, text, text) to service_role"),
    PINNED_SEARCH_PATH: functionBlock.includes("security definer") && functionBlock.includes("set search_path = ''"),
    RLS_ENABLED: ["admin_credentials", "instance_bootstrap"]
      .every((table) => lowerSql.includes(`alter table public.${table} enable row level security`)),
    NO_PUBLIC_POLICIES: !/create\s+policy/i.test(sql),
    NON_DESTRUCTIVE: !/\b(?:drop\s+table|truncate|delete\s+from|alter\s+table\s+public\.(?:users|divisions|roles|system_authority_assignments))\b/i.test(sql),
    SINGLE_ROW_BOOTSTRAP_TABLE: lowerSql.includes("singleton smallint primary key default 1 check (singleton = 1)"),
    NO_PLAINTEXT_PASSWORD_PARAMETER: /bootstrap_first_admin\s*\([^)]*p_password\s+text/i.test(sql) === false
      && functionBlock.includes("p_password_hash text"),
    ADVISORY_LOCK_REUSED: functionBlock.includes("pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0))"),
    THREE_ELIGIBILITY_GUARDS: ["public.instance_bootstrap", "public.system_authority_assignments", "public.admin_credentials"]
      .every((table) => functionBlock.includes(`exists (select 1 from ${table})`)),
    ATOMIC_AUDIT: functionBlock.includes("'first_admin_bootstrap'")
      && functionBlock.includes("'first_admin_bootstrapped'"),
  };
  for (const [name, passed] of Object.entries(checks)) console.log(`${name} = ${passed ? "PASS" : "FAIL"}`);

  const client = createSupabaseClient(loadSupabaseConfig());
  const [bootstrap, authorities] = await Promise.all([
    client.from("instance_bootstrap").select("first_admin_user_id,completed_at", { count: "exact" }).limit(1),
    client.from("system_authority_assignments").select("id", { count: "exact", head: true })
      .eq("authority_code", "SYSTEM_ADMIN").is("revoked_at", null),
  ]);
  const pending = [bootstrap.error?.code, authorities.error?.code].some((code) => ["PGRST205", "PGRST204", "42703"].includes(code ?? ""));
  const livePassed = !bootstrap.error && !authorities.error;
  console.log(`LIVE_BOOTSTRAP_SCHEMA = ${pending ? "PENDING_MIGRATION" : livePassed ? "PASS" : "FAIL"}`);
  if (livePassed) {
    console.log(`BOOTSTRAP_COMPLETED = ${(bootstrap.count ?? 0) === 1 ? "YES" : "NO"}`);
    console.log(`ACTIVE_SYSTEM_ADMINS = ${authorities.count ?? 0}`);
  }
  const passed = Object.values(checks).every(Boolean) && (pending || livePassed);
  console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.log("LIVE_BOOTSTRAP_SCHEMA = FAIL");
  console.log(`error_type: ${error instanceof Error ? error.name : "UnknownError"}`);
  console.log("\nRESULT = FAIL");
  process.exitCode = 1;
});
