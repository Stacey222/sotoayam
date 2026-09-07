import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUPABASE_MIGRATION_ARGUMENTS,
  discoverMigrations,
  runMigrations,
  type MigrationCommandRunner,
} from "../../scripts/migrate.js";

const temporaryDirectories: string[] = [];

async function migrationDirectory(files: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sotoayam-migrations-"));
  temporaryDirectories.push(directory);
  for (const file of files) await writeFile(path.join(directory, file), "select 1;\n", "utf8");
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe("ordered migration runner", () => {
  it("discovers migration files in deterministic filename order", async () => {
    const directory = await migrationDirectory([
      "202609010002_second.sql",
      "202608260001_first.sql",
      "202609010001_third.sql",
    ]);

    await expect(discoverMigrations(directory)).resolves.toEqual([
      "202608260001_first.sql",
      "202609010001_third.sql",
      "202609010002_second.sql",
    ]);
  });

  it("rejects unexpected entries instead of silently skipping them", async () => {
    const directory = await migrationDirectory(["202608260001_valid.sql", "notes.txt"]);
    await expect(discoverMigrations(directory)).rejects.toThrow("Unexpected migration entry: notes.txt");
  });

  it("rejects duplicate migration versions", async () => {
    const directory = await migrationDirectory([
      "202608260001_first.sql",
      "202608260001_duplicate.sql",
    ]);
    await expect(discoverMigrations(directory)).rejects.toThrow("Duplicate migration version: 202608260001");
  });

  it("fails when the migration directory contains no migrations", async () => {
    const directory = await migrationDirectory([]);
    await expect(discoverMigrations(directory)).rejects.toThrow("No migration files found");
  });

  it("uses the Supabase registry command and succeeds when the database is already up to date", async () => {
    const directory = await migrationDirectory(["202608260001_first.sql"]);
    const runner = vi.fn<MigrationCommandRunner>().mockReturnValue({ status: 0 });

    await expect(runMigrations({ migrationsDirectory: directory, runner, stdout: vi.fn(), stderr: vi.fn() }))
      .resolves.toBe(0);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith("supabase", SUPABASE_MIGRATION_ARGUMENTS);
  });

  it("returns the first migration command failure as a non-zero exit code", async () => {
    const directory = await migrationDirectory(["202608260001_first.sql", "202608270001_second.sql"]);
    const runner = vi.fn<MigrationCommandRunner>().mockReturnValue({ status: 7 });
    const stderr = vi.fn();

    await expect(runMigrations({ migrationsDirectory: directory, runner, stdout: vi.fn(), stderr }))
      .resolves.toBe(7);
    expect(runner).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith("MIGRATION_RESULT = FAIL");
  });

  it("does not print environment secrets", async () => {
    const directory = await migrationDirectory(["202608260001_first.sql"]);
    const secret = "database-password-that-must-not-appear";
    vi.stubEnv("SUPABASE_DB_PASSWORD", secret);
    const output: string[] = [];
    const runner = vi.fn<MigrationCommandRunner>().mockReturnValue({ status: 0 });

    await runMigrations({
      migrationsDirectory: directory,
      runner,
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message),
    });

    expect(output.join("\n")).not.toContain(secret);
    expect(JSON.stringify(runner.mock.calls)).not.toContain(secret);
  });

  it("fails preflight without invoking the Supabase CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sotoayam-migrations-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "missing");
    const runner = vi.fn<MigrationCommandRunner>();

    await expect(runMigrations({ migrationsDirectory: directory, runner, stdout: vi.fn(), stderr: vi.fn() }))
      .resolves.toBe(1);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects migration subdirectories instead of ignoring them", async () => {
    const directory = await migrationDirectory(["202608260001_first.sql"]);
    await mkdir(path.join(directory, "archive"));
    await expect(discoverMigrations(directory)).rejects.toThrow("Unexpected migration entry: archive");
  });
});
