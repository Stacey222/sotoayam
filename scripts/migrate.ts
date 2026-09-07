import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATION_FILENAME = /^(\d{12})_[a-z0-9_]+\.sql$/;

export const SUPABASE_MIGRATION_ARGUMENTS = ["db", "push", "--linked", "--yes", "--skip-vault"] as const;

export interface MigrationCommandResult {
  status: number | null;
  error?: Error;
}

export type MigrationCommandRunner = (
  command: string,
  args: readonly string[],
) => MigrationCommandResult;

export interface MigrationRunOptions {
  migrationsDirectory?: string;
  runner?: MigrationCommandRunner;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

export async function discoverMigrations(migrationsDirectory: string): Promise<string[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const invalid = entries.find((entry) => !entry.isFile() || !MIGRATION_FILENAME.test(entry.name));
  if (invalid) throw new Error(`Unexpected migration entry: ${invalid.name}`);

  const migrations = entries.map((entry) => entry.name).sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  if (migrations.length === 0) throw new Error("No migration files found");

  const versions = new Set<string>();
  for (const migration of migrations) {
    const version = migration.slice(0, 12);
    if (versions.has(version)) throw new Error(`Duplicate migration version: ${version}`);
    versions.add(version);
  }
  return migrations;
}

function runSupabase(command: string, args: readonly string[]): MigrationCommandResult {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  return { status: result.status, error: result.error };
}

export async function runMigrations(options: MigrationRunOptions = {}): Promise<number> {
  const migrationsDirectory = options.migrationsDirectory ?? path.resolve("supabase/migrations");
  const runner = options.runner ?? runSupabase;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;

  let migrations: string[];
  try {
    migrations = await discoverMigrations(migrationsDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown migration preflight error";
    stderr(`Migration preflight failed: ${message}`);
    return 1;
  }

  stdout("Sotoayam ordered migrations");
  stdout(`MIGRATIONS_DISCOVERED = ${migrations.length}`);
  for (const migration of migrations) stdout(`- ${migration}`);
  stdout("Applying pending migrations through the Supabase migration registry...");

  const result = runner("supabase", SUPABASE_MIGRATION_ARGUMENTS);
  if (result.error || result.status !== 0) {
    stderr("MIGRATION_RESULT = FAIL");
    stderr("Supabase stopped at the first failed migration; see its preceding error for the migration name.");
    return result.status && result.status > 0 ? result.status : 1;
  }

  stdout("MIGRATION_RESULT = PASS");
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (import.meta.url === invokedPath) process.exitCode = await runMigrations();
