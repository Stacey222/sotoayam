import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolvePostgresTools } from "./check-clean-migrations.js";

export interface DevelopmentDatabaseTarget {
  connectionUrl: string;
  password: string;
  hostname: string;
  mode: "DIRECT" | "SESSION_POOLER";
}

function requireValue(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function normalizedPort(url: URL): string {
  return url.port || "5432";
}

function assertSafeQuery(url: URL): void {
  for (const [name, value] of url.searchParams) {
    if (name !== "sslmode" || value !== "require") {
      throw new Error("Database URL contains unsupported connection options");
    }
  }
}

export function validateDevelopmentDatabaseUrl(rawUrl: string, linkedRef: string,
  linkedPoolerUrl: string): DevelopmentDatabaseTarget {
  let parsed: URL;
  let pooler: URL;
  try {
    parsed = new URL(rawUrl);
    pooler = new URL(linkedPoolerUrl);
  } catch {
    throw new Error("Development database URL format is invalid");
  }
  if (parsed.protocol !== "postgresql:" || parsed.pathname !== "/postgres" ||
      !parsed.username || !parsed.password || normalizedPort(parsed) !== "5432") {
    throw new Error("Database URL is not an approved Supabase administrative connection");
  }
  assertSafeQuery(parsed);
  const isDirect = parsed.hostname === `db.${linkedRef}.supabase.co` && parsed.username === "postgres";
  const poolerMetadataValid = pooler.protocol === "postgresql:" && pooler.pathname === "/postgres" &&
    normalizedPort(pooler) === "5432" && pooler.username === `postgres.${linkedRef}` &&
    pooler.hostname.endsWith(".pooler.supabase.com");
  const isSessionPooler = poolerMetadataValid && parsed.hostname === pooler.hostname &&
    parsed.username === `postgres.${linkedRef}`;
  if (!isDirect && !isSessionPooler) {
    throw new Error("Database URL does not match the linked Direct or Session Pooler identity");
  }
  const password = decodeURIComponent(parsed.password);
  parsed.password = "";
  parsed.search = "";
  parsed.searchParams.set("sslmode", "require");
  return {
    connectionUrl: parsed.toString(),
    password,
    hostname: parsed.hostname,
    mode: isDirect ? "DIRECT" : "SESSION_POOLER",
  };
}

export function assertDevelopmentExecutionContext(environment: NodeJS.ProcessEnv, linkedRef: string,
  confirmationName: string, confirmationValue: string): void {
  if (environment.NODE_ENV === "production") throw new Error("Production environment refused");
  if (!linkedRef || environment.SOTOAYAM_EXPECTED_DEV_PROJECT_REF !== linkedRef ||
      environment.SOTOAYAM_DEV_TARGET !== "development") {
    throw new Error("Explicit linked development project identity is required");
  }
  if (environment[confirmationName] !== confirmationValue) {
    throw new Error(`Explicit ${confirmationName} confirmation is required`);
  }
}

export async function runDevelopmentSql(sql: string, confirmationName: string,
  confirmationValue: string): Promise<void> {
  const ref = readFileSync("supabase/.temp/project-ref", "utf8").trim();
  assertDevelopmentExecutionContext(process.env, ref, confirmationName, confirmationValue);
  const rawUrl = requireValue(process.env.SOTOAYAM_DEV_DATABASE_URL,
    "Explicit Direct or Session Pooler development database URL is required");
  const poolerUrl = readFileSync("supabase/.temp/pooler-url", "utf8").trim();
  const target = validateDevelopmentDatabaseUrl(rawUrl, ref, poolerUrl);
  const tools = await resolvePostgresTools();
  const environment: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: target.password, PGSSLMODE: "require" };
  for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSERVICE"]) delete environment[key];
  const execute = async (statement: string): Promise<string> => await new Promise((resolve, reject) => {
    const child = spawn(tools.psql, ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
      "-d", target.connectionUrl], { env: environment, shell: false, windowsHide: true });
let output = "";
let stderr = "";

child.stdout
  .setEncoding("utf8")
  .on("data", (part: string) => {
    output += part;
  });

child.stderr
  .setEncoding("utf8")
  .on("data", (part: string) => {
    stderr += part;
  });

child.once("error", () => {
  reject(new Error("Database command could not start"));
});

child.once("close", (code) => {
  if (code === 0) {
    resolve(output.trim());
    return;
  }

const safeError = stderr
  .replace(/postgresql:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
  .trim();

  reject(
    new Error(
      safeError
        ? `Development database command failed; transaction rolled back\n${safeError}`
        : "Development database command failed; transaction rolled back",
    ),
  );
});

child.stdin.end(statement);
  });
  const versions = (await execute("select version from supabase_migrations.schema_migrations order by version;"))
    .split(/\r?\n/).filter(Boolean);
  const files = (await import("./migrate.js")).discoverMigrations;
  const localVersions = (await files("supabase/migrations")).map((file) => file.split("_")[0]);
  if (localVersions.length !== 24 || JSON.stringify(versions) !== JSON.stringify(localVersions)) {
    throw new Error("Linked database migration registry does not match the 24 local migrations");
  }
  console.log(`TARGET_PROJECT_REF = ${ref}`);
  console.log(`TARGET_DB = ${target.hostname}/postgres`);
  console.log(`CONNECTION_MODE = ${target.mode}`);
  console.log("MIGRATIONS = 24/24 MATCH");
  await execute(sql);
}
