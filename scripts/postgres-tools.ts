import { access } from "node:fs/promises";
import path from "node:path";

export interface PostgresTools {
  initdb: string;
  pgCtl: string;
  psql: string;
}

export interface PostgresClientTools {
  psql: string;
  pgDump: string;
  pgRestore: string;
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function candidateDirectories(): string[] {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const configured = process.env.SOTOAYAM_TEST_POSTGRES_BIN?.trim();
  return [
    configured,
    ...pathEntries,
    ...(process.platform === "win32"
      ? ["C:\\Program Files\\PostgreSQL\\17\\bin", "C:\\Program Files\\PostgreSQL\\16\\bin"]
      : ["/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin"]),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export async function resolvePostgresClientTools(
  directories: readonly string[] = candidateDirectories(),
): Promise<PostgresClientTools> {
  for (const directory of directories) {
    const tools = {
      psql: path.join(directory, executableName("psql")),
      pgDump: path.join(directory, executableName("pg_dump")),
      pgRestore: path.join(directory, executableName("pg_restore")),
    };
    if ((await exists(tools.psql)) && (await exists(tools.pgDump)) && (await exists(tools.pgRestore))) return tools;
  }

  throw new Error("PostgreSQL psql, pg_dump, and pg_restore were not found");
}

export async function resolvePostgresTools(): Promise<PostgresTools> {
  for (const directory of candidateDirectories()) {
    const tools = {
      initdb: path.join(directory, executableName("initdb")),
      pgCtl: path.join(directory, executableName("pg_ctl")),
      psql: path.join(directory, executableName("psql")),
    };
    if ((await exists(tools.initdb)) && (await exists(tools.pgCtl)) && (await exists(tools.psql))) return tools;
  }

  throw new Error("PostgreSQL initdb, pg_ctl, and psql were not found");
}
