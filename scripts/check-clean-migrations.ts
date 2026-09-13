import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverMigrations } from "./migrate.js";

const EXPECTED_MIGRATION_COUNT = 18;
const REQUIRED_READINESS_RPC = "load_telegram_polling_state()";

export interface MigrationManifest {
  migrations: string[];
  tables: string[];
  functions: string[];
  requiredExtensions: string[];
  serviceRoleRpcs: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface PostgresTools {
  initdb: string;
  pgCtl: string;
  psql: string;
}

interface TargetIdentity {
  address: string;
  port: number;
  database: string;
  dataDirectory: string;
  version: string;
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

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of ["PGDATABASE", "PGHOST", "PGPASSWORD", "PGPORT", "PGSERVICE", "PGUSER"]) {
    delete environment[key];
  }
  return environment;
}

async function run(command: string, args: string[], options: { cwd?: string } = {}): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: sanitizedEnvironment(),
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    // pg_ctl starts postgres as a child process. On Windows that server can retain
    // inherited pipe handles after pg_ctl exits, so waiting for "close" would hang
    // until the database itself stops. The command's "exit" is the correct boundary.
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function normalizeFilePath(value: string): string {
  const resolved = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function assertDisposableIdentity(
  identity: TargetIdentity,
  expectedPort: number,
  expectedDataDirectory: string,
): void {
  const address = identity.address.split("/")[0];
  if (!["127.0.0.1", "::1"].includes(address ?? "")) {
    throw new Error(`Target is not loopback (${identity.address || "empty address"})`);
  }
  if (identity.port !== expectedPort) throw new Error("Target port does not match the isolated cluster");
  if (identity.database !== "postgres") throw new Error("Identity probe used an unexpected database");
  if (normalizeFilePath(identity.dataDirectory) !== normalizeFilePath(expectedDataDirectory)) {
    throw new Error("Target data directory does not match the isolated cluster");
  }
}

function matches(sql: string, expression: RegExp): string[] {
  return [...sql.matchAll(expression)].map((match) => match[1]!.toLowerCase());
}

export async function buildMigrationManifest(migrationsDirectory: string): Promise<MigrationManifest> {
  const migrations = await discoverMigrations(migrationsDirectory);
  const tables = new Set<string>();
  const functions = new Set<string>();
  const requiredExtensions = new Set<string>();
  const serviceRoleRpcs = new Set<string>();
  for (const migration of migrations) {
    const sql = await readFile(path.join(migrationsDirectory, migration), "utf8");
    for (const table of matches(sql, /create\s+table(?:\s+if\s+not\s+exists)?\s+public\.([a-z0-9_]+)/gi)) tables.add(table);
    for (const fn of matches(sql, /create(?:\s+or\s+replace)?\s+function\s+public\.([a-z0-9_]+)/gi)) functions.add(fn);
    for (const extension of matches(sql, /create\s+extension(?:\s+if\s+not\s+exists)?\s+([a-z0-9_]+)/gi)) {
      requiredExtensions.add(extension);
    }
    for (const match of sql.matchAll(
      /grant\s+execute\s+on\s+function\s+public\.([a-z0-9_]+\s*\([^;]*?\))\s+to\s+service_role\s*;/gi,
    )) {
      serviceRoleRpcs.add(match[1]!.replace(/\s+/g, " ").replace(/\s*\(\s*/, "(").replace(/\s*\)/, ")"));
    }
  }
  return {
    migrations,
    tables: [...tables].sort(),
    functions: [...functions].sort(),
    requiredExtensions: [...requiredExtensions].sort(),
    serviceRoleRpcs: [...serviceRoleRpcs].sort(),
  };
}

function postgresUrl(port: number, database: string): string {
  return `postgresql://postgres@127.0.0.1:${port}/${database}`;
}

async function query(psql: string, url: string, sql: string): Promise<string[]> {
  const result = await run(psql, ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", url, "-c", sql]);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function assertSameSet(label: string, actual: string[], expected: string[]): void {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} mismatch: expected ${right.length}, observed ${left.length}`);
  }
}

async function verifySchema(psql: string, url: string, manifest: MigrationManifest): Promise<void> {
  const tables = await query(psql, url,
    "select tablename from pg_tables where schemaname = 'public' order by tablename;");
  assertSameSet("public tables", tables, manifest.tables);

  const rlsTables = await query(psql, url, `
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity order by c.relname;
  `);
  assertSameSet("RLS tables", rlsTables, manifest.tables);

  const functions = await query(psql, url, `
    select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' order by p.proname;
  `);
  assertSameSet("public functions", functions, manifest.functions);

  if (manifest.requiredExtensions.length > 0) {
    const required = manifest.requiredExtensions.map((name) => `'${name.replaceAll("'", "''")}'`).join(",");
    const extensions = await query(psql, url,
      `select extname from pg_extension where extname in (${required}) order by extname;`);
    assertSameSet("required extensions", extensions, manifest.requiredExtensions);
  }

  const rpcValues = manifest.serviceRoleRpcs
    .map((signature) => `('public.${signature.replaceAll("'", "''")}')`)
    .join(",");
  const rpcGrants = await query(psql, url, `
    with expected(signature) as (values ${rpcValues})
    select signature || '|' || (to_regprocedure(signature) is not null)::text || '|'
      || has_function_privilege('service_role', signature, 'EXECUTE')::text || '|'
      || has_function_privilege('anon', signature, 'EXECUTE')::text || '|'
      || has_function_privilege('authenticated', signature, 'EXECUTE')::text
    from expected order by signature;
  `);
  for (const grant of rpcGrants) {
    const [signature, exists, serviceAllowed, anonAllowed, authenticatedAllowed] = grant.split("|");
    if (exists !== "true" || serviceAllowed !== "true" || anonAllowed !== "false" || authenticatedAllowed !== "false") {
      throw new Error(`RPC grants do not match the service-role-only contract: ${signature}`);
    }
  }

  const [policyCount] = await query(psql, url, `
    select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public';
  `);
  if (policyCount !== "0") throw new Error("Unexpected public RLS policies exist");

  const [unsafePrivilegeCount] = await query(psql, url, `
    select count(*) from information_schema.table_privileges
    where table_schema = 'public' and grantee in ('PUBLIC', 'anon', 'authenticated');
  `);
  if (unsafePrivilegeCount !== "0") throw new Error("Public application tables expose unexpected privileges");

  const [unsafeDefinerCount] = await query(psql, url, `
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not coalesce(p.proconfig, array[]::text[]) @> array['search_path=""'];
  `);
  if (unsafeDefinerCount !== "0") throw new Error("A SECURITY DEFINER function lacks the fixed empty search_path");

  const [serviceAllowed, anonAllowed, authenticatedAllowed] = await query(psql, url, `
    select has_function_privilege('service_role', 'public.${REQUIRED_READINESS_RPC}', 'EXECUTE'),
      has_function_privilege('anon', 'public.${REQUIRED_READINESS_RPC}', 'EXECUTE'),
      has_function_privilege('authenticated', 'public.${REQUIRED_READINESS_RPC}', 'EXECUTE');
  `).then((rows) => rows[0]!.split("|"));
  if (serviceAllowed !== "t" || anonAllowed !== "f" || authenticatedAllowed !== "f") {
    throw new Error("Readiness RPC grants do not match the service-role-only contract");
  }

  const readinessResult = await query(psql, url,
    "set role service_role; select public.load_telegram_polling_state(); reset role;");
  if (!readinessResult.includes("0")) throw new Error("Readiness RPC did not execute with its initial state");
}

async function applyCleanDatabase(
  tools: PostgresTools,
  port: number,
  database: string,
  migrationsDirectory: string,
  manifest: MigrationManifest,
): Promise<void> {
  const adminUrl = postgresUrl(port, "postgres");
  await run(tools.psql, ["-X", "-v", "ON_ERROR_STOP=1", "-d", adminUrl, "-c",
    `create database ${database} template template0 encoding 'UTF8';`]);
  const url = postgresUrl(port, database);
  for (const migration of manifest.migrations) {
    await run(tools.psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", url, "-f",
      path.join(migrationsDirectory, migration)]);
  }
  await verifySchema(tools.psql, url, manifest);
}

export async function runCleanMigrationCheck(stdout: (line: string) => void = console.log): Promise<void> {
  const migrationsDirectory = path.resolve("supabase/migrations");
  const manifest = await buildMigrationManifest(migrationsDirectory);
  if (manifest.migrations.length !== EXPECTED_MIGRATION_COUNT) {
    throw new Error(`Expected ${EXPECTED_MIGRATION_COUNT} migrations, found ${manifest.migrations.length}`);
  }

  const tools = await resolvePostgresTools();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sotoayam-p109-"));
  const dataDirectory = path.join(temporaryRoot, "postgres-data");
  const logFile = path.join(temporaryRoot, "postgres.log");
  const port = await reserveLoopbackPort();
  let started = false;

  try {
    await run(tools.initdb, ["-D", dataDirectory, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--no-locale"]);
    await run(tools.pgCtl, ["-D", dataDirectory, "-l", logFile, "-o", `-p ${port} -h 127.0.0.1`, "-w", "-t", "30", "start"]);
    started = true;

    const identityParts = (await query(tools.psql, postgresUrl(port, "postgres"), `
      select coalesce(inet_server_addr()::text, ''), inet_server_port(), current_database(),
        current_setting('data_directory'), current_setting('server_version');
    `))[0]!.split("|");
    const identity: TargetIdentity = {
      address: identityParts[0]!,
      port: Number(identityParts[1]),
      database: identityParts[2]!,
      dataDirectory: identityParts[3]!,
      version: identityParts[4]!,
    };
    assertDisposableIdentity(identity, port, dataDirectory);

    stdout("DISPOSABLE_TARGET = isolated local PostgreSQL cluster");
    stdout(`POSTGRES_VERSION = ${identity.version}`);
    stdout("TARGET_LOOPBACK = PASS");
    stdout("TARGET_DATA_DIRECTORY_MATCH = PASS");
    stdout(`MIGRATIONS_DISCOVERED = ${manifest.migrations.length}`);

    await run(tools.psql, ["-X", "-v", "ON_ERROR_STOP=1", "-d", postgresUrl(port, "postgres"), "-c", `
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
    `]);

    for (const runNumber of [1, 2]) {
      await applyCleanDatabase(tools, port, `sotoayam_p109_clean_${runNumber}`, migrationsDirectory, manifest);
      stdout(`RUN_${runNumber}_MIGRATIONS = ${manifest.migrations.length}/${EXPECTED_MIGRATION_COUNT} PASS`);
      stdout(`RUN_${runNumber}_SCHEMA_SECURITY = PASS`);
    }
    stdout(`TABLES = ${manifest.tables.length}/${manifest.tables.length} PASS`);
    stdout(`FUNCTIONS = ${manifest.functions.length}/${manifest.functions.length} PASS`);
    stdout(`SERVICE_ROLE_RPCS = ${manifest.serviceRoleRpcs.length}/${manifest.serviceRoleRpcs.length} PASS`);
    stdout(`REQUIRED_EXTENSIONS = ${manifest.requiredExtensions.length}/${manifest.requiredExtensions.length} PASS`);
    stdout("RLS = PASS");
    stdout("NO_PUBLIC_POLICIES = PASS");
    stdout("READINESS_RPC = PASS");
    stdout("RESULT = PASS");
  } finally {
    if (started) {
      await run(tools.pgCtl, ["-D", dataDirectory, "-m", "fast", "-w", "-t", "30", "stop"])
        .catch(() => undefined);
    }
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (import.meta.url === invokedPath) {
  try {
    await runCleanMigrationCheck();
  } catch (error) {
    console.error(`RESULT = FAIL: ${error instanceof Error ? error.message : "Unknown clean migration error"}`);
    process.exitCode = 1;
  }
}
