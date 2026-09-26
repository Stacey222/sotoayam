import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverMigrations } from "./migrate.js";
import { resolvePostgresTools } from "./check-clean-migrations.js";

export const BACKUP_FORMAT = "SOTOAYAM_LOGICAL_DATA_V1";
export const RESTORE_CONFIRMATION = "RESTORE_SOTOAYAM_BACKUP";
export const EXCLUDED_TABLE_DATA = [
  "public.admin_sessions",
  "public.admin_login_attempts",
  "public.telegram_pairing_tokens",
  // P2-03 keeps the seven legacy booleans authoritative during shadow mode.
  // The telegram_users INSERT trigger reconstructs these normalized rows; dumping
  // them as well would collide with that fail-safe mirrored-write behavior.
  "public.telegram_notification_preferences",
] as const;

const RECOVERY_EMPTY_TABLES = [
  "admin_credentials",
  "admin_login_attempts",
  "admin_sessions",
  "critical_alerts",
  "installation_provenance",
  "instance_bootstrap",
  "integration_capabilities",
  "integration_credentials",
  "notification_deliveries",
  "notification_events",
  "notification_routing_rules",
  "notifications",
  "system_authority_assignments",
  "task_activities",
  "task_import_batches",
  "task_relationships",
  "task_reminder_states",
  "task_source_integrations",
  "tasks",
  "telegram_notification_preferences",
  "telegram_pairing_tokens",
  "telegram_processed_updates",
  "telegram_users",
  "user_channels",
  "users",
] as const;

const POST_RESTORE_INVARIANT_EXPECTED = "1|1|1|1|1|1|1|1|1|1|1";
const POST_RESTORE_INVARIANT_EXPRESSION = `
  (exists(select 1 from public.users u join public.roles r on r.id=u.role_id and r.code='OWNER' and r.active
    join public.admin_credentials c on c.user_id=u.id where u.active and not c.password_change_required))::int||'|'
  ||(exists(select 1 from public.system_authority_assignments a join public.users u on u.id=a.user_id and u.active
    join public.divisions d on d.id=u.division_id and d.active and d.grants_system_authority
    where a.authority_code='SYSTEM_ADMIN' and a.revoked_at is null))::int||'|'
  ||(exists(select 1 from public.instance_settings s where s.business_actor_user_id is not null
    and public.is_business_actor_eligible(s.business_actor_user_id)))::int||'|'
  ||(exists(select 1 from public.instance_bootstrap b join public.users u on u.id=b.first_admin_user_id
    join public.admin_credentials c on c.user_id=u.id))::int||'|'
  ||(not exists(select 1 from public.users u where u.legacy_telegram_user_id is not null and not exists(
    select 1 from public.telegram_users t join public.user_channels c on c.user_id=u.id and c.channel_type='TELEGRAM'
    and c.external_id=t.telegram_chat_id::text where t.id=u.legacy_telegram_user_id)))::int||'|'
  ||(not exists(select 1 from public.telegram_users t where 7<>(select count(*) from public.telegram_notification_preferences p
    where p.telegram_user_id=t.id)))::int||'|'
  ||(exists(select 1 from public.instance_settings s where s.business_time_zone is not null
    and s.reminder_scheduler_interval_seconds is not null and public.is_valid_critical_alert_policy(s.critical_alert_policy)))::int||'|'
  ||((select count(*)=0 from public.admin_sessions))::int||'|'
  ||((select count(*)=0 from public.telegram_pairing_tokens))::int||'|'
  ||(exists(select 1 from public.load_telegram_polling_state()))::int||'|'
  ||((select count(*)=1 from public.installation_provenance))::int`;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  created_at: string;
  migration_count: number;
  migration_versions: string[];
  application_commit: string;
  source: { project_ref: string; connection_mode: "DIRECT" | "SESSION_POOLER" | "DISPOSABLE"; database: string };
  artifact_file: string;
  checksum: { algorithm: "sha256"; value: string };
  excluded_table_data: string[];
}

export interface ValidatedDatabaseTarget {
  connectionUrl: string;
  password: string;
  projectRef: string;
  database: string;
  mode: "DIRECT" | "SESSION_POOLER" | "DISPOSABLE";
  sanitizedIdentity: string;
}

interface ProcessResult { stdout: string; stderr: string }
interface BackupTools { psql: string; pgDump: string; pgRestore: string }

function redact(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/(?:password|PGPASSWORD)\s*[=:]\s*[^\s]+/gi, "$1=[REDACTED]")
    .trim();
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function resolveBackupTools(): Promise<BackupTools> {
  const base = await resolvePostgresTools();
  const directory = path.dirname(base.psql);
  const pgDump = path.join(directory, executableName("pg_dump"));
  const pgRestore = path.join(directory, executableName("pg_restore"));
  await Promise.all([access(pgDump), access(pgRestore)]).catch(() => {
    throw new Error("PostgreSQL pg_dump and pg_restore were not found beside psql");
  });
  return { psql: base.psql, pgDump, pgRestore };
}

function databaseEnvironment(password: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: password };
  // Supabase targets carry sslmode=require in their validated connection URL.
  // Removing inherited PGSSLMODE also lets the isolated non-TLS test cluster be exercised safely.
  for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSERVICE", "PGSSLMODE"]) delete environment[key];
  return environment;
}

async function run(command: string, args: string[], password = ""): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: databaseEnvironment(password), shell: false, windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", () => reject(new Error(`${path.basename(command)} could not start`)));
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr })
      : reject(new Error(`${path.basename(command)} failed: ${redact(stderr || stdout)}`)));
  });
}

function assertSafeQuery(url: URL, requireSsl: boolean): void {
  for (const [name, value] of url.searchParams) {
    if (name !== "sslmode" || value !== "require") throw new Error("Database URL contains unsupported options");
  }
  if (requireSsl && url.searchParams.get("sslmode") !== "require") {
    throw new Error("Supabase database URL must include sslmode=require");
  }
}

export function validateDatabaseTarget(rawUrl: string, expectedProjectRef: string,
  options: { allowDisposableLoopback?: boolean; expectedDatabase?: string } = {}): ValidatedDatabaseTarget {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error("Database URL format is invalid"); }
  if (parsed.protocol !== "postgresql:" || !parsed.username || !parsed.pathname.startsWith("/")) {
    throw new Error("Database URL is not an approved PostgreSQL connection");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!database || (options.expectedDatabase && database !== options.expectedDatabase)) {
    throw new Error("Database URL does not match the expected database");
  }
  const port = parsed.port || "5432";
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  if (options.allowDisposableLoopback && loopback) {
    if (process.env.NODE_ENV !== "test") throw new Error("Disposable database connections are test-only");
    assertSafeQuery(parsed, false);
    const password = decodeURIComponent(parsed.password);
    parsed.password = ""; parsed.search = "";
    return { connectionUrl: parsed.toString(), password, projectRef: "disposable", database,
      mode: "DISPOSABLE", sanitizedIdentity: `${parsed.hostname}:${port}/${database}` };
  }
  if (!/^[a-z0-9]{20}$/.test(expectedProjectRef) || !parsed.password || port !== "5432") {
    throw new Error("Explicit Supabase project identity and administrative credentials are required");
  }
  assertSafeQuery(parsed, true);
  const direct = parsed.hostname === `db.${expectedProjectRef}.supabase.co` && parsed.username === "postgres";
  const sessionPooler = parsed.hostname.endsWith(".pooler.supabase.com")
    && parsed.username === `postgres.${expectedProjectRef}`;
  if (!direct && !sessionPooler) throw new Error("Database URL does not match the expected Supabase project");
  const password = decodeURIComponent(parsed.password);
  parsed.password = ""; parsed.search = ""; parsed.searchParams.set("sslmode", "require");
  return { connectionUrl: parsed.toString(), password, projectRef: expectedProjectRef, database,
    mode: direct ? "DIRECT" : "SESSION_POOLER",
    sanitizedIdentity: `${direct ? `db.${expectedProjectRef}.supabase.co` : parsed.hostname}:5432/${database}` };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => createReadStream(file).on("data", (chunk) => hash.update(chunk))
    .once("error", reject).once("end", resolve));
  return hash.digest("hex");
}

async function localMigrationVersions(): Promise<string[]> {
  return (await discoverMigrations(path.resolve("supabase/migrations"))).map((name) => name.slice(0, 12));
}

async function query(tools: BackupTools, target: ValidatedDatabaseTarget, sql: string): Promise<string[]> {
  const result = await run(tools.psql, ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", target.connectionUrl, "-c", sql], target.password);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function assertMigrationRegistry(tools: BackupTools, target: ValidatedDatabaseTarget,
  expected: string[]): Promise<void> {
  const versions = await query(tools, target,
    "select version from supabase_migrations.schema_migrations order by version;");
  if (JSON.stringify(versions) !== JSON.stringify(expected)) {
    throw new Error(`Migration registry mismatch: expected ${expected.length}, observed ${versions.length}`);
  }
}

async function gitCommit(): Promise<string> {
  try { return (await run("git", ["rev-parse", "HEAD"])).stdout.trim(); }
  catch { return "UNKNOWN"; }
}

async function pathExists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

export async function createBackup(input: { databaseUrl: string; expectedProjectRef: string;
  outputDirectory: string; allowDisposableLoopback?: boolean; expectedDatabase?: string;
  now?: Date; stdout?: (message: string) => void }): Promise<{ artifactPath: string; manifestPath: string; manifest: BackupManifest }> {
  const stdout = input.stdout ?? console.log;
  const target = validateDatabaseTarget(input.databaseUrl, input.expectedProjectRef,
    { allowDisposableLoopback: input.allowDisposableLoopback, expectedDatabase: input.expectedDatabase });
  const tools = await resolveBackupTools();
  const versions = await localMigrationVersions();
  await assertMigrationRegistry(tools, target, versions);
  const timestamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  await mkdir(input.outputDirectory, { recursive: true });
  const artifactPath = path.resolve(input.outputDirectory, `sotoayam-${timestamp}.dump`);
  const partialArtifact = `${artifactPath}.partial`;
  const manifestPath = `${artifactPath}.manifest.json`;
  const partialManifest = `${manifestPath}.partial`;
  if (await pathExists(artifactPath) || await pathExists(manifestPath)) {
    throw new Error("Backup artifact timestamp already exists; refusing to overwrite it");
  }
  await rm(partialArtifact, { force: true }); await rm(partialManifest, { force: true });
  stdout(`SOURCE_DB = ${target.sanitizedIdentity}`); stdout(`CONNECTION_MODE = ${target.mode}`);
  try {
    await run(tools.pgDump, ["--format=custom", "--data-only", "--schema=public", "--no-owner", "--no-privileges",
      ...EXCLUDED_TABLE_DATA.map((table) => `--exclude-table-data=${table}`),
      "--file", partialArtifact, "--dbname", target.connectionUrl], target.password);
    await chmod(partialArtifact, 0o600).catch(() => undefined);
    const manifest: BackupManifest = { format: BACKUP_FORMAT, created_at: (input.now ?? new Date()).toISOString(),
      migration_count: versions.length, migration_versions: versions, application_commit: await gitCommit(),
      source: { project_ref: target.projectRef, connection_mode: target.mode, database: target.database },
      artifact_file: path.basename(artifactPath), checksum: { algorithm: "sha256", value: await sha256(partialArtifact) },
      excluded_table_data: [...EXCLUDED_TABLE_DATA] };
    await writeFile(partialManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(partialArtifact, artifactPath); await rename(partialManifest, manifestPath);
    stdout(`BACKUP_ARTIFACT = ${artifactPath}`); stdout(`BACKUP_MANIFEST = ${manifestPath}`); stdout("BACKUP_RESULT = PASS");
    return { artifactPath, manifestPath, manifest };
  } catch (error) {
    await rm(partialArtifact, { force: true }); await rm(partialManifest, { force: true });
    await rm(artifactPath, { force: true }); await rm(manifestPath, { force: true });
    throw error;
  }
}

function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup manifest is invalid");
  const manifest = value as Partial<BackupManifest>;
  if (manifest.format !== BACKUP_FORMAT || manifest.checksum?.algorithm !== "sha256"
    || !/^[0-9a-f]{64}$/.test(manifest.checksum.value ?? "") || !Array.isArray(manifest.migration_versions)
    || manifest.migration_versions.some((version) => !/^\d{12}$/.test(version))
    || manifest.migration_count !== manifest.migration_versions.length || typeof manifest.artifact_file !== "string"
    || path.basename(manifest.artifact_file) !== manifest.artifact_file
    || typeof manifest.created_at !== "string" || !Number.isFinite(Date.parse(manifest.created_at))
    || typeof manifest.application_commit !== "string"
    || !/^(?:[0-9a-f]{40}|UNKNOWN)$/.test(manifest.application_commit)
    || !manifest.source || typeof manifest.source.database !== "string" || !manifest.source.database
    || typeof manifest.source.project_ref !== "string" || !manifest.source.project_ref
    || !["DIRECT", "SESSION_POOLER", "DISPOSABLE"].includes(manifest.source.connection_mode ?? "")
    || JSON.stringify(manifest.excluded_table_data) !== JSON.stringify(EXCLUDED_TABLE_DATA)) {
    throw new Error("Backup manifest format is unsupported or incomplete");
  }
  return manifest as BackupManifest;
}

export async function verifyBackup(artifactPath: string,
  options: { stdout?: (message: string) => void } = {}): Promise<BackupManifest> {
  const stdout = options.stdout ?? console.log;
  const resolvedArtifact = path.resolve(artifactPath);
  const manifestPath = `${resolvedArtifact}.manifest.json`;
  await Promise.all([stat(resolvedArtifact), stat(manifestPath)]).catch(() => { throw new Error("Backup artifact or manifest is missing"); });
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (manifest.artifact_file !== path.basename(resolvedArtifact)) throw new Error("Manifest artifact name does not match");
  if (await sha256(resolvedArtifact) !== manifest.checksum.value) throw new Error("Backup checksum mismatch");
  const versions = await localMigrationVersions();
  if (JSON.stringify(manifest.migration_versions) !== JSON.stringify(versions)) {
    throw new Error("Backup migration version is not supported by this Sotoayam build");
  }
  const tools = await resolveBackupTools();
  await run(tools.pgRestore, ["--list", resolvedArtifact]);
  stdout(`BACKUP_FORMAT = ${manifest.format}`); stdout(`MIGRATIONS = ${manifest.migration_count}/${versions.length} MATCH`);
  stdout("CHECKSUM = PASS"); stdout("ARCHIVE_READABLE = PASS"); stdout("BACKUP_VERIFY_RESULT = PASS");
  return manifest;
}

async function restoreInTransaction(tools: BackupTools, target: ValidatedDatabaseTarget,
  truncateSql: string, restoreSqlPath: string, validationSql: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tools.psql, ["-X", "-v", "ON_ERROR_STOP=1", "-d", target.connectionUrl],
      { env: databaseEnvironment(target.password), shell: false, windowsHide: true });
    let stderr = ""; child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.resume();
    child.once("error", () => reject(new Error("psql could not start")));
    child.once("close", (code) => code === 0 ? resolve()
      : reject(new Error(`Restore transaction failed and was rolled back: ${redact(stderr)}`)));
    child.stdin.write(`begin;\n${truncateSql}\n`);
    const input = createReadStream(restoreSqlPath);
    input.once("error", reject);
    input.once("end", () => child.stdin.end(`\n${validationSql}\ncommit;\n`));
    input.pipe(child.stdin, { end: false });
  });
}

export async function restoreBackup(input: { artifactPath: string; databaseUrl: string;
  expectedProjectRef: string; confirmation: string; recoveryTarget: string;
  allowDisposableLoopback?: boolean; expectedDatabase?: string; stdout?: (message: string) => void }): Promise<void> {
  if (input.confirmation !== RESTORE_CONFIRMATION) throw new Error(`Exact confirmation ${RESTORE_CONFIRMATION} is required`);
  if (input.recoveryTarget !== "recovery") throw new Error("Target must be explicitly marked as recovery");
  const stdout = input.stdout ?? console.log;
  const manifest = await verifyBackup(input.artifactPath, { stdout });
  const target = validateDatabaseTarget(input.databaseUrl, input.expectedProjectRef,
    { allowDisposableLoopback: input.allowDisposableLoopback, expectedDatabase: input.expectedDatabase });
  const tools = await resolveBackupTools();
  await assertMigrationRegistry(tools, target, manifest.migration_versions);
  const [evidence] = await query(tools, target, `select ${RECOVERY_EMPTY_TABLES
    .map((table) => `(select count(*) from public.${table})`).join("+")};`);
  if (evidence !== "0") throw new Error("Recovery target is not clean; restore refused");
  stdout(`TARGET_DB = ${target.sanitizedIdentity}`); stdout(`CONNECTION_MODE = ${target.mode}`);
  const tables = await query(tools, target,
    "select format('%I.%I',schemaname,tablename) from pg_tables where schemaname='public' order by tablename;");
  if (tables.length === 0) throw new Error("Recovery target has no migrated application schema");
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sotoayam-restore-"));
  const restoreSql = path.join(temporaryDirectory, "restore.sql");
  try {
    await run(tools.pgRestore, ["--data-only", "--no-owner", "--no-privileges", "--file", restoreSql,
      path.resolve(input.artifactPath)]);
    const transactionalValidation = `select 1 / ((${POST_RESTORE_INVARIANT_EXPRESSION})
      = '${POST_RESTORE_INVARIANT_EXPECTED}')::int;`;
    await restoreInTransaction(tools, target, `truncate table ${tables.join(", ")};`, restoreSql,
      transactionalValidation);
    const [result] = await query(tools, target, `select ${POST_RESTORE_INVARIANT_EXPRESSION};`);
    if (result !== POST_RESTORE_INVARIANT_EXPECTED) throw new Error("Post-restore Sotoayam invariants failed");
    stdout("OWNER = PASS"); stdout("SYSTEM_ADMIN = PASS"); stdout("BUSINESS_ACTOR = PASS");
    stdout("BOOTSTRAP = PASS"); stdout("TELEGRAM_MAPPING = PASS"); stdout("NOTIFICATION_PREFERENCES = PASS");
    stdout("RUNTIME_SETTINGS = PASS"); stdout("EPHEMERAL_SESSIONS = CLEARED");
    stdout("READINESS_SCHEMA = PASS"); stdout("INSTALLATION_PROVENANCE = PASS"); stdout("RESTORE_RESULT = PASS");
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}
