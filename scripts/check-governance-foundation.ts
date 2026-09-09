import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PERMISSION_SEEDS,
  ROLE_PERMISSION_SEEDS,
  ROLE_SEEDS,
} from "../src/governance/catalog.js";
import {
  FOUNDATION_PERMISSION_SEEDS,
  FOUNDATION_ROLE_PERMISSION_SEEDS,
  LEGACY_DIVISION_SEEDS,
} from "./fixtures/legacy-governance-foundation.js";

const MIGRATION = "202608290001_create_governance_foundation.sql";

export interface GovernanceMigration {
  name: string;
  sql: string;
}

export interface GovernancePermissionHistory {
  permissions: ReadonlySet<string>;
  roleGrants: ReadonlyMap<string, ReadonlySet<string>>;
  permissionAdditions: ReadonlyMap<string, readonly string[]>;
  roleGrantAdditions: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  valid: boolean;
}

export interface GovernancePermissionChecks {
  PERMISSION_SEED: boolean;
  STAFF_GRANTS: boolean;
  ADMIN_GRANTS: boolean;
  OWNER_GRANTS: boolean;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function catalogSeedCodes(sql: string, table: "divisions" | "roles" | "permissions"): string[] {
  const block = sql.match(
    new RegExp(`insert into public\\.${table} \\(code, name\\)[\\s\\S]*?values([\\s\\S]*?)on conflict \\(code\\) do nothing;`),
  )?.[1] ?? "";
  return [...block.matchAll(/\('([^']+)',/g)].map((match) => match[1] as string);
}

function permissionInsertions(sql: string): string[] {
  const blocks = [...sql.matchAll(
    /insert\s+into\s+public\.permissions\s*\(\s*code\s*,\s*name\s*\)\s*values([\s\S]*?)on\s+conflict\s*\(\s*code\s*\)\s+do\s+nothing\s*;/gi,
  )];
  return blocks.flatMap((block) => [...block[1]!.matchAll(/\(\s*'([a-z][a-z0-9_.]*)'\s*,/g)]
    .map((match) => match[1] as string));
}

function roleGrantInsertions(sql: string): { grants: Map<string, string[]>; valid: boolean } {
  const grants = new Map<string, string[]>();
  const blocks = [...sql.matchAll(
    /insert\s+into\s+public\.role_permissions\s*\(\s*role_id\s*,\s*permission_id\s*\)([\s\S]*?)on\s+conflict\s*\(\s*role_id\s*,\s*permission_id\s*\)\s+do\s+nothing\s*;/gi,
  )];
  let valid = true;
  for (const block of blocks) {
    const statement = block[1]!;
    const role = statement.match(/where\s+(?:[a-z_][a-z0-9_]*\.)?code\s*=\s*'([A-Z][A-Z0-9_]*)'/i)?.[1];
    const permissions = [...statement.matchAll(/'([a-z][a-z0-9_.]*)'/g)].map((match) => match[1] as string);
    if (!role || permissions.length === 0) {
      valid = false;
      continue;
    }
    grants.set(role, [...(grants.get(role) ?? []), ...permissions]);
  }
  return { grants, valid };
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return new Set(actual).size === actual.length
    && new Set(expected).size === expected.length
    && actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

export function buildGovernancePermissionHistory(
  migrations: readonly GovernanceMigration[],
): GovernancePermissionHistory {
  const permissions = new Set<string>();
  const roleGrants = new Map<string, Set<string>>();
  const permissionAdditions = new Map<string, readonly string[]>();
  const roleGrantAdditions = new Map<string, ReadonlyMap<string, readonly string[]>>();
  let valid = true;

  for (const migration of migrations) {
    if (/\b(?:delete\s+from|truncate\s+(?:table\s+)?|update)\s+public\.(?:permissions|role_permissions)\b/i.test(migration.sql)) {
      valid = false;
    }
    const addedPermissions = permissionInsertions(migration.sql);
    if (addedPermissions.length > 0) permissionAdditions.set(migration.name, addedPermissions);
    for (const permission of addedPermissions) permissions.add(permission);

    const addedGrants = roleGrantInsertions(migration.sql);
    valid = valid && addedGrants.valid;
    if (addedGrants.grants.size > 0) roleGrantAdditions.set(migration.name, addedGrants.grants);
    for (const [role, permissionCodes] of addedGrants.grants) {
      const effective = roleGrants.get(role) ?? new Set<string>();
      for (const permission of permissionCodes) effective.add(permission);
      roleGrants.set(role, effective);
    }
  }

  return { permissions, roleGrants, permissionAdditions, roleGrantAdditions, valid };
}

export function evaluateGovernancePermissionHistory(
  migrations: readonly GovernanceMigration[],
): GovernancePermissionChecks {
  const foundation = migrations.find((migration) => migration.name === MIGRATION);
  const foundationHistory = buildGovernancePermissionHistory(foundation ? [foundation] : []);
  const effectiveHistory = buildGovernancePermissionHistory(migrations);
  const exactFoundationPermissions = foundationHistory.valid
    && sameSet([...foundationHistory.permissions], FOUNDATION_PERMISSION_SEEDS);
  const exactEffectivePermissions = effectiveHistory.valid
    && sameSet([...effectiveHistory.permissions], PERMISSION_SEEDS);

  const roleCheck = (role: keyof typeof ROLE_PERMISSION_SEEDS): boolean => (
    sameSet(
      [...(foundationHistory.roleGrants.get(role) ?? [])],
      FOUNDATION_ROLE_PERMISSION_SEEDS[role],
    )
    && sameSet(
      [...(effectiveHistory.roleGrants.get(role) ?? [])],
      ROLE_PERMISSION_SEEDS[role],
    )
  );

  return {
    PERMISSION_SEED: unique(PERMISSION_SEEDS) && exactFoundationPermissions && exactEffectivePermissions,
    STAFF_GRANTS: roleCheck("STAFF"),
    ADMIN_GRANTS: roleCheck("ADMIN"),
    OWNER_GRANTS: roleCheck("OWNER"),
  };
}

async function readMigrationChain(migrationsDirectory: string): Promise<GovernanceMigration[]> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{12}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  return Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(path.join(migrationsDirectory, name), "utf8"),
  })));
}

async function main(): Promise<void> {
  console.log("Sotoayam Governance Foundation\n");
  const migrationsDirectory = path.resolve(process.cwd(), "supabase", "migrations");
  const migrationPath = path.join(migrationsDirectory, MIGRATION);
  const sql = await readFile(migrationPath, "utf8");
  const permissionChecks = evaluateGovernancePermissionHistory(await readMigrationChain(migrationsDirectory));
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
    DIVISION_SEED: unique(LEGACY_DIVISION_SEEDS.map(({ code }) => code))
      && sameSet(catalogSeedCodes(sql, "divisions"), LEGACY_DIVISION_SEEDS.map(({ code }) => code)),
    ROLE_SEED: unique(ROLE_SEEDS) && sameSet(catalogSeedCodes(sql, "roles"), ROLE_SEEDS),
    ...permissionChecks,
    AUTHORITY_SEPARATE: sql.includes("authority_code = 'SYSTEM_ADMIN'") && !sql.includes("telegram_chat_id"),
    AUDIT_APPEND_ONLY: sql.includes("before update or delete on public.audit_logs"),
    IDEMPOTENT_SEED: (sql.match(/on conflict \([^)]*\) do nothing|on conflict \(code\) do nothing/g) ?? []).length >= 6,
  };

  for (const [name, passed] of Object.entries(checks)) console.log(`${name} = ${passed ? "PASS" : "FAIL"}`);
  const passed = Object.values(checks).every(Boolean);
  console.log("VALIDATION_SCOPE = LOCAL_MIGRATION_CONTRACT");
  console.log("LIVE_MIGRATION_STATUS = VERIFY_WITH_AUTHORIZED_TOOLING");
  console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.log("LOCAL_GOVERNANCE_MIGRATION = FAIL");
    console.log(`error_message: ${error instanceof Error ? error.message.slice(0, 200) : "Unexpected checker failure"}`);
    console.log("\nRESULT = FAIL");
    process.exitCode = 1;
  });
}
