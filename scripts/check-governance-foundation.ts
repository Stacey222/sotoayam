import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DIVISION_SEEDS,
  PERMISSION_SEEDS,
  ROLE_PERMISSION_SEEDS,
  ROLE_SEEDS,
} from "../src/governance/catalog.js";

const MIGRATION = "202608290001_create_governance_foundation.sql";

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function catalogSeedCodes(sql: string, table: "divisions" | "roles" | "permissions"): string[] {
  const block = sql.match(
    new RegExp(`insert into public\\.${table} \\(code, name\\)[\\s\\S]*?values([\\s\\S]*?)on conflict \\(code\\) do nothing;`),
  )?.[1] ?? "";
  return [...block.matchAll(/\('([^']+)',/g)].map((match) => match[1] as string);
}

function roleGrantCodes(sql: string, role: keyof typeof ROLE_PERMISSION_SEEDS): string[] {
  const blocks = [...sql.matchAll(/join public\.permissions[\s\S]*?on permission_catalog\.code in \(([\s\S]*?)\)\s*where role_catalog\.code = '([A-Z_]+)'/g)];
  const block = blocks.find((match) => match[2] === role)?.[1] ?? "";
  return [...block.matchAll(/'([a-z][a-z0-9_.]*)'/g)].map((match) => match[1] as string);
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

async function main(): Promise<void> {
  console.log("Gwens Governance Foundation\n");
  const migrationPath = path.resolve(process.cwd(), "supabase", "migrations", MIGRATION);
  const sql = await readFile(migrationPath, "utf8");
  const requiredTables = [
    "divisions",
    "roles",
    "permissions",
    "role_permissions",
    "system_authority_assignments",
    "audit_logs",
  ];

  const checks = {
    TABLES: requiredTables.every((table) => sql.includes(`create table if not exists public.${table}`)),
    RLS: requiredTables.every((table) => sql.includes(`alter table public.${table} enable row level security`)),
    NO_PUBLIC_POLICIES: !/create\s+policy/i.test(sql),
    NON_DESTRUCTIVE: !/\b(?:drop\s+table|truncate|delete\s+from)\b/i.test(sql),
    DIVISION_SEED: unique(DIVISION_SEEDS.map(({ code }) => code))
      && sameSet(catalogSeedCodes(sql, "divisions"), DIVISION_SEEDS.map(({ code }) => code)),
    ROLE_SEED: unique(ROLE_SEEDS) && sameSet(catalogSeedCodes(sql, "roles"), ROLE_SEEDS),
    PERMISSION_SEED: unique(PERMISSION_SEEDS)
      && sameSet(catalogSeedCodes(sql, "permissions"), PERMISSION_SEEDS),
    STAFF_GRANTS: sameSet(roleGrantCodes(sql, "STAFF"), ROLE_PERMISSION_SEEDS.STAFF),
    ADMIN_GRANTS: sameSet(roleGrantCodes(sql, "ADMIN"), ROLE_PERMISSION_SEEDS.ADMIN),
    OWNER_GRANTS: sameSet(roleGrantCodes(sql, "OWNER"), ROLE_PERMISSION_SEEDS.OWNER),
    AUTHORITY_SEPARATE: sql.includes("authority_code = 'SYSTEM_ADMIN'") && !sql.includes("telegram_chat_id"),
    AUDIT_APPEND_ONLY: sql.includes("before update or delete on public.audit_logs"),
    IDEMPOTENT_SEED: (sql.match(/on conflict \([^)]*\) do nothing|on conflict \(code\) do nothing/g) ?? []).length >= 6,
  };

  for (const [name, passed] of Object.entries(checks)) console.log(`${name} = ${passed ? "PASS" : "FAIL"}`);
  const passed = Object.values(checks).every(Boolean);
  console.log("LIVE_MIGRATION_STATUS = NOT_APPLIED_BY_THIS_TASK");
  console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.log("LOCAL_GOVERNANCE_MIGRATION = FAIL");
  console.log(`error_message: ${error instanceof Error ? error.message.slice(0, 200) : "Unexpected checker failure"}`);
  console.log("\nRESULT = FAIL");
  process.exitCode = 1;
});
