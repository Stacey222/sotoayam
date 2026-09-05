import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { loadSupabaseConfig } from "../src/config/env.js";
import { createSupabaseClient } from "../src/db/supabase.js";
import type {
  ChannelIdentitySnapshot,
  LegacyIdentitySnapshot,
  NormalizedIdentitySnapshot,
} from "../src/identity/types.js";
import { reconcileIdentitySnapshots } from "../src/services/identity-reconciliation.service.js";

export const RECONCILIATION_STATUSES = [
  "MATCH",
  "MISSING_NORMALIZED",
  "MISSING_LEGACY",
  "MISMATCH",
  "DUPLICATE",
] as const;

interface RelationCode {
  code: string;
}

interface NormalizedUserRow {
  id: number;
  legacy_telegram_user_id: number | null;
  active: boolean;
  division: RelationCode | RelationCode[] | null;
  business_role: RelationCode | RelationCode[] | null;
}

function relationCode(value: RelationCode | RelationCode[] | null): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0]?.code ?? null : value.code;
}

function safeError(value: string | undefined): string {
  return (value ?? "Identity reconciliation failed")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .slice(0, 240);
}

async function normalizedSchemaDeclared(): Promise<boolean> {
  const migrationDirectory = path.resolve(process.cwd(), "supabase/migrations");
  const migrationNames = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const migrationSql = (await Promise.all(
    migrationNames.map((name) => readFile(path.join(migrationDirectory, name), "utf8")),
  )).join("\n");
  return /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.users\b/i.test(migrationSql)
    && /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.user_channels\b/i.test(migrationSql);
}

async function main(): Promise<void> {
  console.log("Sotoayam Legacy Identity Reconciliation\n");
  if (!(await normalizedSchemaDeclared())) {
    console.log("NORMALIZED_SCHEMA = NOT_APPLICABLE");
    console.log("IDENTITY_COMPARISON = NOT_APPLICABLE");
    console.log(`SUPPORTED_STATUSES = ${RECONCILIATION_STATUSES.join(",")}`);
    console.log("MODE = READ_ONLY");
    console.log("\nRESULT = PASS");
    return;
  }

  const client = createSupabaseClient(loadSupabaseConfig());
  const [legacyResult, usersResult, channelsResult] = await Promise.all([
    client.from("telegram_users").select("id,telegram_chat_id,division,role,active"),
    client.from("users").select("id,legacy_telegram_user_id,active,division:divisions(code),business_role:roles(code)"),
    client.from("user_channels").select("id,user_id,channel_type,external_id"),
  ]);

  const normalizedError = usersResult.error ?? channelsResult.error;
  if (normalizedError?.code === "PGRST205" || normalizedError?.code === "42P01") {
    console.log("NORMALIZED_SCHEMA = PENDING_LIVE");
    console.log("IDENTITY_COMPARISON = PENDING_MIGRATION");
    console.log(`SUPPORTED_STATUSES = ${RECONCILIATION_STATUSES.join(",")}`);
    console.log("MODE = READ_ONLY");
    console.log("\nRESULT = PASS");
    return;
  }

  const error = legacyResult.error ?? normalizedError;
  if (error) throw new Error(`${error.code ?? "UNKNOWN"}: ${safeError(error.message)}`);

  const legacy = (legacyResult.data ?? []) as LegacyIdentitySnapshot[];
  const normalized = ((usersResult.data ?? []) as unknown as NormalizedUserRow[]).map<NormalizedIdentitySnapshot>((row) => ({
    id: row.id,
    legacy_telegram_user_id: row.legacy_telegram_user_id,
    active: row.active,
    division_code: relationCode(row.division),
    role_code: relationCode(row.business_role),
  }));
  const channels = (channelsResult.data ?? []) as ChannelIdentitySnapshot[];
  const counts = reconcileIdentitySnapshots(legacy, normalized, channels);
  const passed = counts.match === legacy.length
    && counts.missingNormalized === 0
    && counts.missingLegacy === 0
    && counts.mismatch === 0
    && counts.duplicate === 0;

  console.log("NORMALIZED_SCHEMA = DETECTED");
  console.log(`MATCH = ${counts.match}`);
  console.log(`MISSING_NORMALIZED = ${counts.missingNormalized}`);
  console.log(`MISSING_LEGACY = ${counts.missingLegacy}`);
  console.log(`MISMATCH = ${counts.mismatch}`);
  console.log(`DUPLICATE = ${counts.duplicate}`);
  console.log(`IDENTITY_RECONCILIATION = ${passed ? "PASS" : "FAIL"}`);
  console.log("MODE = READ_ONLY");
  console.log(`\nRESULT = ${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.log("NORMALIZED_SCHEMA = UNKNOWN");
  console.log(`error_message: ${safeError(error instanceof Error ? error.message : undefined)}`);
  console.log("\nRESULT = FAIL");
  process.exitCode = 1;
});
