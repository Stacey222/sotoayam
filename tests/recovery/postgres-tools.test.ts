import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePostgresClientTools } from "../../scripts/postgres-tools.js";

const temporaryDirectories: string[] = [];
const originalConfiguredBin = process.env.SOTOAYAM_TEST_POSTGRES_BIN;

async function fakeExecutable(directory: string, name: string): Promise<string> {
  const file = path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
  await writeFile(file, "test executable\n", "utf8");
  if (process.platform !== "win32") await chmod(file, 0o755);
  return file;
}

afterEach(async () => {
  if (originalConfiguredBin === undefined) delete process.env.SOTOAYAM_TEST_POSTGRES_BIN;
  else process.env.SOTOAYAM_TEST_POSTGRES_BIN = originalConfiguredBin;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PostgreSQL tool resolution", () => {
  it("accepts a production client-only installation for backup and restore", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sotoayam-pg-client-"));
    temporaryDirectories.push(directory);
    process.env.SOTOAYAM_TEST_POSTGRES_BIN = directory;
    const psql = await fakeExecutable(directory, "psql");
    const pgDump = await fakeExecutable(directory, "pg_dump");
    const pgRestore = await fakeExecutable(directory, "pg_restore");

    await expect(resolvePostgresClientTools([directory])).resolves.toEqual({ psql, pgDump, pgRestore });
  });

  it.each(["psql", "pg_dump", "pg_restore"])(
    "fails clearly when the required %s client tool is absent",
    async (missingTool) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "sotoayam-pg-client-missing-"));
      temporaryDirectories.push(directory);
      process.env.SOTOAYAM_TEST_POSTGRES_BIN = directory;
      for (const tool of ["psql", "pg_dump", "pg_restore"]) {
        if (tool !== missingTool) await fakeExecutable(directory, tool);
      }

      await expect(resolvePostgresClientTools([directory])).rejects.toThrow(
        "PostgreSQL psql, pg_dump, and pg_restore were not found",
      );
    },
  );
});
