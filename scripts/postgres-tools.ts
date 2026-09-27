import { access } from "node:fs/promises";
import path from "node:path";

export interface PostgresTools {
  initdb: string;
  pgCtl: string;
  psql: string;
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

export async function resolvePostgresTools(): Promise<PostgresTools> {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const configured = process.env.SOTOAYAM_TEST_POSTGRES_BIN?.trim();
  const candidates = [
    configured,
    ...pathEntries,
    ...(process.platform === "win32"
      ? ["C:\\Program Files\\PostgreSQL\\17\\bin", "C:\\Program Files\\PostgreSQL\\16\\bin"]
      : ["/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin"]),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const directory of candidates) {
    const tools = {
      initdb: path.join(directory, executableName("initdb")),
      pgCtl: path.join(directory, executableName("pg_ctl")),
      psql: path.join(directory, executableName("psql")),
    };
    if ((await exists(tools.initdb)) && (await exists(tools.pgCtl)) && (await exists(tools.psql))) return tools;
  }

  throw new Error("PostgreSQL initdb, pg_ctl, and psql were not found");
}
