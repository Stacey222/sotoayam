import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverMigrations } from "./migrate.js";

const EXPECTED_MIGRATION_COUNT = 23;
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

export async function buildMigrationManifest(migrationsDirectory: string, migrationCount?: number): Promise<MigrationManifest> {
  const discovered = await discoverMigrations(migrationsDirectory);
  const migrations = migrationCount === undefined ? discovered : discovered.slice(0, migrationCount);
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
): Promise<string> {
  const adminUrl = postgresUrl(port, "postgres");
  await run(tools.psql, ["-X", "-v", "ON_ERROR_STOP=1", "-d", adminUrl, "-c",
    `create database ${database} template template0 encoding 'UTF8';`]);
  const url = postgresUrl(port, database);
  for (const migration of manifest.migrations) {
    await run(tools.psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", url, "-f",
      path.join(migrationsDirectory, migration)]);
  }
  await verifySchema(tools.psql, url, manifest);
  return url;
}

export interface DisposablePostgresDatabase {
  readonly url: string;
  query(sql: string): Promise<string[]>;
  attempt(sql: string): Promise<{ ok: boolean; rows: string[]; error: string }>;
  close(): Promise<void>;
}

/** Starts a migration-complete PostgreSQL cluster owned by a newly-created temporary directory.
 * The identity probe deliberately fails closed before exposing the handle to a test. */
export async function startDisposablePostgresDatabase(prefix = "sotoayam-integration-", migrationCount = EXPECTED_MIGRATION_COUNT): Promise<DisposablePostgresDatabase> {
  const migrationsDirectory = path.resolve("supabase/migrations");
  const discovered = await discoverMigrations(migrationsDirectory);
  if (discovered.length !== EXPECTED_MIGRATION_COUNT || migrationCount < 1 || migrationCount > EXPECTED_MIGRATION_COUNT) {
    throw new Error(`Expected ${EXPECTED_MIGRATION_COUNT} repository migrations and a valid requested prefix, found ${discovered.length}/${migrationCount}`);
  }
  const manifest = await buildMigrationManifest(migrationsDirectory, migrationCount);
  const tools = await resolvePostgresTools();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dataDirectory = path.join(temporaryRoot, "postgres-data");
  const logFile = path.join(temporaryRoot, "postgres.log");
  const port = await reserveLoopbackPort();
  let started = false;
  try {
    await run(tools.initdb, ["-D", dataDirectory, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--no-locale"]);
    await run(tools.pgCtl, ["-D", dataDirectory, "-l", logFile, "-o", `-p ${port} -h 127.0.0.1`, "-w", "-t", "30", "start"]);
    started = true;
    const adminUrl = postgresUrl(port, "postgres");
    const identityParts = (await query(tools.psql, adminUrl, `select coalesce(inet_server_addr()::text, ''),
      inet_server_port(), current_database(), current_setting('data_directory'), current_setting('server_version');`))[0]!.split("|");
    assertDisposableIdentity({ address: identityParts[0]!, port: Number(identityParts[1]), database: identityParts[2]!,
      dataDirectory: identityParts[3]!, version: identityParts[4]! }, port, dataDirectory);
    await run(tools.psql, ["-X", "-v", "ON_ERROR_STOP=1", "-d", adminUrl, "-c", `
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
    `]);
    const database = `sotoayam_integration_${process.pid}_${Date.now()}`;
    const url = await applyCleanDatabase(tools, port, database, migrationsDirectory, manifest);
    let closed = false;
    return {
      url,
      query: (sql) => query(tools.psql, url, sql),
      attempt: async (sql) => {
        try { return { ok: true, rows: await query(tools.psql, url, sql), error: "" }; }
        catch (error) { return { ok: false, rows: [], error: error instanceof Error ? error.message : String(error) }; }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (started) await run(tools.pgCtl, ["-D", dataDirectory, "-m", "fast", "-w", "-t", "30", "stop"])
          .catch(() => undefined);
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      },
    };
  } catch (error) {
    if (started) await run(tools.pgCtl, ["-D", dataDirectory, "-m", "fast", "-w", "-t", "30", "stop"])
      .catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

async function verifyBootstrapCompatibility(psql: string, url: string): Promise<void> {
  await query(psql, url, `
    begin;
    select * from public.provision_first_installation(
      'P2 Bootstrap Admin', 'p2-bootstrap@example.test', 'scrypt', repeat('h', 64),
      'FRESH', 'OPERATIONS', 'Operations'
    );
    do $verify$
    begin
      if not exists (
        select 1 from public.system_authority_assignments assignments
        join public.users users on users.id = assignments.user_id
        join public.divisions divisions on divisions.id = users.division_id
        where assignments.revoked_at is null and users.active and divisions.active
          and divisions.grants_system_authority
      ) then raise exception 'bootstrap did not create an effective SYSTEM_ADMIN'; end if;
    end $verify$;
    rollback;
  `);
}

async function verifySystemAdminInvariant(psql: string, url: string): Promise<void> {
  await query(psql, url, `
    insert into public.divisions (id, code, name, active, grants_system_authority, provisioning_source)
    overriding system value
    values (91001, 'P2_AUTHORITY', 'P2 Authority', true, true, 'CUSTOMER'),
           (91002, 'P2_STANDARD', 'P2 Standard', true, false, 'CUSTOMER');
    insert into public.users (id, display_name, division_id, role_id, active)
    overriding system value
    select fixture.id, fixture.name, 91001, roles.id, true
    from (values (91101::bigint, 'Admin A'), (91102::bigint, 'Admin B')) fixture(id, name)
    cross join public.roles roles where roles.code = 'ADMIN';
    insert into public.system_authority_assignments (user_id, authority_code, reason)
    values (91101, 'SYSTEM_ADMIN', 'P2 invariant fixture'),
           (91102, 'SYSTEM_ADMIN', 'P2 invariant fixture');
  `);

  await query(psql, url, `
    begin;
    select * from public.update_user_access(91101, 91001, (select id from public.roles where code='ADMIN'), false,
      91102, 'p2_invariant_test');
    do $verify$ begin
      begin
        perform public.update_user_access(91102, 91001, (select id from public.roles where code='ADMIN'), false,
          91102, 'p2_invariant_test');
        raise exception using errcode='P9999', message='expected SELF_DEACTIVATION_FORBIDDEN';
      exception when insufficient_privilege then
        if sqlerrm <> 'SELF_DEACTIVATION_FORBIDDEN' then raise; end if;
      end;
    end $verify$;
    rollback;

    begin;
    select * from public.update_user_access(91102, 91001, (select id from public.roles where code='ADMIN'), false,
      91101, 'p2_invariant_test');
    do $verify$ begin
      begin
        perform public.revoke_system_admin(91101, 'must retain one', 91101);
        raise exception using errcode='P9999', message='expected LAST_SYSTEM_ADMIN';
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'LAST_SYSTEM_ADMIN' then raise; end if;
      end;
    end $verify$;
    rollback;

    begin;
    select * from public.update_user_access(91102, 91001, (select id from public.roles where code='ADMIN'), false,
      91101, 'p2_invariant_test');
    do $verify$ begin
      begin
        perform public.update_user_access(91101, 91002, (select id from public.roles where code='ADMIN'), true,
          91101, 'p2_invariant_test');
        raise exception using errcode='P9999', message='expected SELF_DEMOTION_CONFIRMATION_REQUIRED';
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'SELF_DEMOTION_CONFIRMATION_REQUIRED' then raise; end if;
      end;
    end $verify$;
    rollback;

    begin;
    do $verify$ begin
      begin
        perform public.set_division_system_authority(91001, false, 91101, 'p2_invariant_test');
        raise exception using errcode='P9999', message='expected LAST_SYSTEM_ADMIN';
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'LAST_SYSTEM_ADMIN' then raise; end if;
      end;
    end $verify$;
    rollback;

    begin;
    do $verify$ begin
      begin
        perform public.update_customer_division(91001, null, false, 91101, 'p2_invariant_test');
        raise exception using errcode='P9999', message='expected LAST_SYSTEM_ADMIN';
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'LAST_SYSTEM_ADMIN' then raise; end if;
      end;
    end $verify$;
    rollback;

    begin;
    select * from public.revoke_system_admin(91102, 'demote before attempted self grant', 91101);
    do $verify$ begin
      begin
        perform public.assign_system_admin(91102, 'unauthorized self restore', 91102);
        raise exception using errcode='P9999', message='expected actor rejection';
      exception when insufficient_privilege then null;
      end;
    end $verify$;
    rollback;

    begin;
    insert into public.users (id, display_name, division_id, role_id, active)
    overriding system value
    select 91103, 'Admin C', 91001, id, true from public.roles where code='ADMIN';
    select * from public.assign_system_admin(91103, 'attributed grant', 91101);
    do $verify$ begin
      if not exists (select 1 from public.audit_logs where action='SYSTEM_ADMIN_GRANTED'
        and object_id=(select id::text from public.system_authority_assignments where user_id=91103 and revoked_at is null)
        and actor_type='USER' and actor_user_id=91101 and source='admin_session_api') then
        raise exception 'real actor attribution missing';
      end if;
    end $verify$;
    rollback;
  `);

  const concurrent = await Promise.allSettled([
    run(psql, ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", url, "-c",
      "select id from public.revoke_system_admin(91102,'concurrent mutual revoke',91101);"]),
    run(psql, ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", url, "-c",
      "select id from public.revoke_system_admin(91101,'concurrent mutual revoke',91102);"]),
  ]);
  if (concurrent.filter((result) => result.status === "fulfilled").length !== 1) {
    throw new Error("Concurrent mutual revoke did not permit exactly one operation");
  }
  const [effectiveCount] = await query(psql, url, `
    select count(*) from public.system_authority_assignments assignments
    join public.users users on users.id=assignments.user_id
    join public.divisions divisions on divisions.id=users.division_id
    where assignments.revoked_at is null and users.active and divisions.active and divisions.grants_system_authority;
  `);
  if (effectiveCount !== "1") throw new Error("Concurrent mutual revoke did not retain exactly one effective administrator");
  const [attributedAuditCount] = await query(psql, url, `
    select count(*) from public.audit_logs where action='SYSTEM_ADMIN_REVOKED'
      and actor_type='USER' and actor_user_id is not null and source='admin_session_api';
  `);
  if (attributedAuditCount !== "1") throw new Error("Concurrent authority audit lacks the real actor attribution");

  const [remainingActor] = await query(psql, url, `
    select users.id from public.system_authority_assignments assignments
    join public.users users on users.id=assignments.user_id
    join public.divisions divisions on divisions.id=users.division_id
    where assignments.revoked_at is null and users.active and divisions.active and divisions.grants_system_authority
    order by users.id limit 1;
  `);
  const secondActor = remainingActor === "91101" ? "91102" : "91101";
  await query(psql, url, `select id from public.assign_system_admin(${secondActor},'mixed concurrency fixture',${remainingActor});`);
  const mixedConcurrent = await Promise.allSettled([
    run(psql, ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", url, "-c",
      `select id from public.revoke_system_admin(${secondActor},'mixed concurrent revoke',${remainingActor});`]),
    run(psql, ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", url, "-c",
      `select id from public.update_managed_user_access(${remainingActor},91001,
        (select id from public.roles where code='ADMIN'),false,${secondActor},'p2_invariant_test',false,null);`]),
  ]);
  if (mixedConcurrent.filter((result) => result.status === "fulfilled").length !== 1) {
    throw new Error("Concurrent revoke/deactivation did not permit exactly one operation");
  }
  const [mixedEffectiveCount] = await query(psql, url, `select public.count_effective_system_admins();`);
  if (mixedEffectiveCount !== "1") throw new Error("Concurrent revoke/deactivation did not retain one effective administrator");
}

async function verifyAdminUserManagement(psql: string, url: string): Promise<void> {
  await query(psql, url, `
    do $verify$
    declare
      actor_id bigint;
      created_id bigint;
      operational_id bigint;
      before_users bigint;
      before_credentials bigint;
      admin_role_id bigint;
    begin
      select users.id into actor_id
      from public.system_authority_assignments assignments
      join public.users users on users.id=assignments.user_id
      join public.divisions divisions on divisions.id=users.division_id
      where assignments.revoked_at is null and users.active and divisions.active and divisions.grants_system_authority
      order by users.id limit 1;
      select id into admin_role_id from public.roles where code='ADMIN';
      if actor_id is null or admin_role_id is null then raise exception 'P2-09 fixture actor missing'; end if;

      select user_id into created_id from public.create_administrator_account(
        'P2-09 Created Admin', 'p209-created@example.test', 91001, admin_role_id, true,
        'P2-09 clean verification', 'scrypt', repeat('h', 64), actor_id);
      if not exists (select 1 from public.admin_credentials where user_id=created_id
          and email='p209-created@example.test' and password_change_required) then
        raise exception 'P2-09 administrator credential state missing';
      end if;
      if not public.is_effective_system_admin(created_id) then raise exception 'P2-09 optional authority grant missing'; end if;
      if not exists (select 1 from public.audit_logs where action='ADMIN_USER_CREATED'
          and object_id=created_id::text and actor_type='USER' and actor_user_id=actor_id) then
        raise exception 'P2-09 administrator audit attribution missing';
      end if;
      if exists (select 1 from public.user_channels where user_id=created_id) then
        raise exception 'P2-09 administrator creation invented channel identity';
      end if;

      select count(*), (select count(*) from public.admin_credentials) into before_users, before_credentials
      from public.users;
      begin
        perform public.create_administrator_account(
          'Atomic Failure', 'p209-atomic@example.test', 91002, admin_role_id, true,
          'must roll back', 'scrypt', repeat('x', 64), actor_id);
        raise exception using errcode='P9999', message='expected ineligible authority failure';
      exception when sqlstate 'P0001' then null;
      end;
      if (select count(*) from public.users) <> before_users
          or (select count(*) from public.admin_credentials) <> before_credentials then
        raise exception 'P2-09 failed creation left partial state';
      end if;

      insert into public.users (display_name, division_id, role_id, active)
      values ('P2-09 Operational', 91002, admin_role_id, true) returning id into operational_id;
      perform public.grant_admin_login(operational_id, 'p209-operational@example.test',
        'P2-09 login grant', 'scrypt', repeat('g', 64), actor_id);
      if exists (select 1 from public.user_channels where user_id=operational_id) then
        raise exception 'P2-09 login grant invented channel identity';
      end if;
      insert into public.admin_sessions (user_id, token_hash, csrf_token_hash, expires_at)
      values (operational_id, repeat('a', 64), repeat('b', 64), now() + interval '1 hour');
      perform public.update_managed_user_access(operational_id, 91002, admin_role_id, false,
        actor_id, 'admin_user_management_api', false, null);
      if exists (select 1 from public.admin_sessions where user_id=operational_id and revoked_at is null) then
        raise exception 'P2-09 deactivation did not revoke sessions atomically';
      end if;

      perform public.change_admin_password(created_id, 'scrypt', repeat('n', 64), created_id, null);
      if (select password_change_required from public.admin_credentials where user_id=created_id) then
        raise exception 'P2-09 password change did not clear restriction';
      end if;
      if (select count(*) from public.list_managed_admin_users(actor_id, 'p209-created@example.test',
          'active', 91001, true, true, 2, null, null)) <> 1 then
        raise exception 'P2-09 composed list filter mismatch';
      end if;
    end $verify$;
  `);
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
      const url = await applyCleanDatabase(tools, port, `sotoayam_p109_clean_${runNumber}`, migrationsDirectory, manifest);
      await verifyBootstrapCompatibility(tools.psql, url);
      if (runNumber === 1) {
        await verifySystemAdminInvariant(tools.psql, url);
        await verifyAdminUserManagement(tools.psql, url);
      }
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
    stdout("FIRST_ADMIN_BOOTSTRAP = PASS");
    stdout("SYSTEM_ADMIN_INVARIANT = PASS");
    stdout("ADMIN_USER_MANAGEMENT = PASS");
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
