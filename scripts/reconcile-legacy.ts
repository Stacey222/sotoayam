import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const RECONCILIATION_STATUSES = [
  "MATCH",
  "MISSING_NORMALIZED",
  "MISSING_LEGACY",
  "MISMATCH",
  "DUPLICATE",
] as const;

export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export interface IdentityReconciliationResult {
  status: ReconciliationStatus;
  legacyCount: number;
  normalizedCount: number;
  mismatchCount: number;
}

async function main(): Promise<void> {
  console.log("Gwens Legacy Identity Reconciliation\n");
  const migrationDirectory = path.resolve(process.cwd(), "supabase/migrations");
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrationSql = (await Promise.all(
    migrationNames.map((name) => readFile(path.join(migrationDirectory, name), "utf8")),
  )).join("\n");

  const normalizedUsersDeclared = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?users\b/i.test(migrationSql);
  const normalizedChannelsDeclared = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?user_channels\b/i.test(migrationSql);
  const applicable = normalizedUsersDeclared && normalizedChannelsDeclared;

  console.log(`NORMALIZED_SCHEMA = ${applicable ? "DETECTED" : "NOT_APPLICABLE"}`);
  console.log(`IDENTITY_COMPARISON = ${applicable ? "NOT_IMPLEMENTED" : "NOT_APPLICABLE"}`);
  console.log(`SUPPORTED_STATUSES = ${RECONCILIATION_STATUSES.join(",")}`);
  console.log("MODE = DRY_RUN_ONLY");
  console.log(`\nRESULT = ${applicable ? "FAIL" : "PASS"}`);

  if (applicable) {
    console.log("reason: Normalized identity migrations exist; implement the Slice 2 comparator before proceeding.");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.log("NORMALIZED_SCHEMA = UNKNOWN");
  console.log(`error_type: ${error instanceof Error ? error.name : "UnknownError"}`);
  console.log("\nRESULT = FAIL");
  process.exitCode = 1;
});
