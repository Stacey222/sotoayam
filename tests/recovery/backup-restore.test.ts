import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/auth/admin-password.js";
import { hashOpaqueToken } from "../../src/auth/admin-session.js";
import {
  BACKUP_FORMAT,
  RESTORE_CONFIRMATION,
  createBackup,
  restoreBackup,
  validateDatabaseTarget,
  verifyBackup,
  type BackupManifest,
} from "../../scripts/backup-recovery.js";
import { discoverMigrations } from "../../scripts/migrate.js";
import {
  startDisposablePostgresDatabase,
  type DisposablePostgresDatabase,
} from "../../scripts/check-clean-migrations.js";

const fixturePassword = "correct horse battery staple";
const pairingRawToken = "p".repeat(43);
const policy = JSON.stringify({
  overdue: { warningHours: 1, highHours: 24, criticalHours: 72 },
  blocked: { warningHours: 4, highHours: 24, criticalHours: 72 },
  scheduler: { staleMinutes: 15, criticalMinutes: 60 },
});

let source: DisposablePostgresDatabase;
let temporaryDirectory = "";
let artifactPath = "";
let manifestPath = "";
let manifest: BackupManifest;
let ownerId = 0;
let dirtyLedgerError = "";
let invalidRestoreError = "";
let invalidRestoreOutput: string[] = [];
let rollbackState = "";

async function installMigrationRegistry(database: DisposablePostgresDatabase): Promise<void> {
  const versions = (await discoverMigrations(path.resolve("supabase/migrations")))
    .map((migration) => migration.slice(0, 12));
  await database.query(`create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key);`);
  await database.query(`insert into supabase_migrations.schema_migrations(version) values
    ${versions.map((version) => `('${version}')`).join(",")};`);
}

async function scalar(database: DisposablePostgresDatabase, sql: string): Promise<string> {
  return (await database.query(sql))[0]!;
}

describe("P3-03 backup and customer recovery", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sotoayam-p303-test-"));
    source = await startDisposablePostgresDatabase("sotoayam-p303-source-");
    await installMigrationRegistry(source);

    const invalidBackup = await createBackup({
      databaseUrl: source.url,
      expectedProjectRef: "",
      outputDirectory: temporaryDirectory,
      expectedDatabase: new URL(source.url).pathname.slice(1),
      allowDisposableLoopback: true,
      now: new Date("2026-09-26T11:00:00.000Z"),
      stdout: () => undefined,
    });

    const passwordHash = await hashPassword(fixturePassword);
    ownerId = Number((await source.query(`select user_id from public.provision_first_owner(
      'Recovery Owner','recovery-owner@example.invalid','scrypt','${passwordHash}',
      'OPERATIONS','Operations','Asia/Jakarta',300,'${policy}'::jsonb)`))[0]);
    const pairingHash = hashOpaqueToken(pairingRawToken);
    await source.query(`select * from public.create_telegram_pairing(
      ${ownerId},'${pairingHash}',now()+interval '10 minutes')`);
    await source.query(`select id from public.consume_telegram_pairing(
      '${pairingHash}',987654321,'recovery_owner','Recovery Owner')`);
    await source.query(`select * from public.update_own_telegram_preferences(
      ${ownerId},true,false,true,false,true,true,true)`);
    await source.query(`insert into public.tasks(
      title,description,status,priority,source,created_by_user_id,requesting_division_id,owner_division_id)
      select 'Recovery task','P3-03 disposable fixture','OPEN','HIGH','MANUAL',u.id,u.division_id,u.division_id
      from public.users u where u.id=${ownerId};`);
    await source.query(`insert into public.admin_sessions(
      user_id,token_hash,csrf_token_hash,expires_at)
      values(${ownerId},repeat('a',64),repeat('b',64),now()+interval '1 hour');`);

    const output: string[] = [];
    const result = await createBackup({
      databaseUrl: source.url,
      expectedProjectRef: "",
      outputDirectory: temporaryDirectory,
      expectedDatabase: new URL(source.url).pathname.slice(1),
      allowDisposableLoopback: true,
      now: new Date("2026-09-26T12:00:00.000Z"),
      stdout: (message) => output.push(message),
    });
    ({ artifactPath, manifestPath, manifest } = result);
    expect(output).toContain("BACKUP_RESULT = PASS");
    const publicTables = await source.query(
      "select format('%I.%I',schemaname,tablename) from pg_tables where schemaname='public' order by tablename;",
    );
    await source.query(`begin; truncate table ${publicTables.join(", ")}; commit;`);
    await source.query(`insert into public.telegram_processed_updates(
      update_id,status,update_type,completed_at) values(1,'COMPLETED','other',now());`);
    try {
      await restoreBackup({
        artifactPath,
        databaseUrl: source.url,
        expectedProjectRef: "",
        confirmation: RESTORE_CONFIRMATION,
        recoveryTarget: "recovery",
        expectedDatabase: new URL(source.url).pathname.slice(1),
        allowDisposableLoopback: true,
        stdout: () => undefined,
      });
    } catch (error) { dirtyLedgerError = error instanceof Error ? error.message : String(error); }
    await source.query("delete from public.telegram_processed_updates;");

    const beforeInvalidRestore = await scalar(source, `select
      (select count(*) from public.roles)||'|'||(select count(*) from public.divisions)||'|'
      ||(select count(*) from public.users)||'|'||(select count(*) from public.instance_settings)`);
    try {
      await restoreBackup({
        artifactPath: invalidBackup.artifactPath,
        databaseUrl: source.url,
        expectedProjectRef: "",
        confirmation: RESTORE_CONFIRMATION,
        recoveryTarget: "recovery",
        expectedDatabase: new URL(source.url).pathname.slice(1),
        allowDisposableLoopback: true,
        stdout: (message) => invalidRestoreOutput.push(message),
      });
    } catch (error) { invalidRestoreError = error instanceof Error ? error.message : String(error); }
    rollbackState = `${beforeInvalidRestore}->${await scalar(source, `select
      (select count(*) from public.roles)||'|'||(select count(*) from public.divisions)||'|'
      ||(select count(*) from public.users)||'|'||(select count(*) from public.instance_settings)`)}`;
    await restoreBackup({
      artifactPath,
      databaseUrl: source.url,
      expectedProjectRef: "",
      confirmation: RESTORE_CONFIRMATION,
      recoveryTarget: "recovery",
      expectedDatabase: new URL(source.url).pathname.slice(1),
      allowDisposableLoopback: true,
      stdout: () => undefined,
    });
  }, 300_000);

  afterAll(async () => {
    await source?.close();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }, 60_000);

  it("creates a non-secret V1 manifest and verifies its checksum and archive", async () => {
    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.migration_count).toBe(25);
    expect(manifest.migration_versions).toHaveLength(25);
    expect(manifest.source.connection_mode).toBe("DISPOSABLE");
    expect(manifest.excluded_table_data).toEqual([
      "public.admin_sessions",
      "public.admin_login_attempts",
      "public.telegram_pairing_tokens",
      "public.telegram_notification_preferences",
    ]);
    const serialized = await readFile(manifestPath, "utf8");
    expect(serialized).not.toContain(fixturePassword);
    expect(serialized).not.toContain(pairingRawToken);
    expect(serialized).not.toContain("987654321");
    expect(serialized).not.toContain(source.url);
    await expect(verifyBackup(artifactPath, { stdout: () => undefined })).resolves.toMatchObject({
      format: BACKUP_FORMAT,
      checksum: { algorithm: "sha256" },
    });
  });

  it("restores OWNER, SYSTEM_ADMIN, settings, task, Telegram mapping, and preferences", async () => {
    expect(await scalar(source, `select r.code||'|'||u.active||'|'||(a.id is not null)::text||'|'
      ||(s.business_actor_user_id=u.id)::text||'|'||(b.first_admin_user_id=u.id)::text
      from public.users u join public.roles r on r.id=u.role_id
      join public.system_authority_assignments a on a.user_id=u.id and a.revoked_at is null
      cross join public.instance_settings s cross join public.instance_bootstrap b
      where u.id=${ownerId}`)).toBe("OWNER|true|true|true|true");
    expect(await scalar(source, `select (select count(*) from public.tasks where title='Recovery task')||'|'
      ||(select count(*) from public.telegram_users where telegram_chat_id=987654321)||'|'
      ||(select count(*) from public.telegram_notification_preferences p join public.users u
        on u.legacy_telegram_user_id=p.telegram_user_id where u.id=${ownerId})`)).toBe("1|1|7");
    expect(await scalar(source, `select count(*) from public.telegram_notification_preferences p
      join public.users u on u.legacy_telegram_user_id=p.telegram_user_id
      where u.id=${ownerId} and p.enabled`)).toBe("5");
    expect(await scalar(source, `select (select count(*) from public.admin_sessions)||'|'
      ||(select count(*) from public.admin_login_attempts)||'|'
      ||(select count(*) from public.telegram_pairing_tokens)`)).toBe("0|0|0");
    await expect(verifyPassword(fixturePassword,
      await scalar(source, `select password_hash from public.admin_credentials where user_id=${ownerId}`)))
      .resolves.toBe(true);
  });

  it("rejects hidden operational dirt and rolls back a restore whose invariants fail", () => {
    expect(dirtyLedgerError).toContain("Recovery target is not clean");
    expect(invalidRestoreError).toContain("Restore transaction failed and was rolled back");
    expect(invalidRestoreOutput).not.toContain("RESTORE_RESULT = PASS");
    const [before, after] = rollbackState.split("->");
    expect(after).toBe(before);
  });

  it("keeps setup closed after restore", async () => {
    const replay = await source.attempt(`select * from public.provision_first_owner(
      'Replay Owner','replay@example.invalid','scrypt',repeat('c',64),
      'REPLAY','Replay','Asia/Jakarta',300,'${policy}'::jsonb)`);
    expect(replay.ok).toBe(false);
    expect(replay.error).toContain("FIRST_ADMIN_ALREADY_EXISTS");
  });

  it("rejects checksum corruption and unsupported formats before restore", async () => {
    const corruptedArtifact = path.join(temporaryDirectory, "corrupted.dump");
    const artifact = await readFile(artifactPath);
    const corruptedIndex = Math.floor(artifact.length / 2);
    artifact[corruptedIndex] = artifact[corruptedIndex]! ^ 0xff;
    await writeFile(corruptedArtifact, artifact);
    await writeFile(`${corruptedArtifact}.manifest.json`, JSON.stringify({
      ...manifest,
      artifact_file: path.basename(corruptedArtifact),
    }));
    await expect(verifyBackup(corruptedArtifact, { stdout: () => undefined }))
      .rejects.toThrow("Backup checksum mismatch");

    const unsupportedArtifact = path.join(temporaryDirectory, "unsupported.dump");
    await writeFile(unsupportedArtifact, await readFile(artifactPath));
    await writeFile(`${unsupportedArtifact}.manifest.json`, JSON.stringify({
      ...manifest,
      format: "SOTOAYAM_LOGICAL_DATA_V999",
      artifact_file: path.basename(unsupportedArtifact),
    }));
    await expect(verifyBackup(unsupportedArtifact, { stdout: () => undefined }))
      .rejects.toThrow("Backup manifest format is unsupported or incomplete");
  });

  it("requires the exact confirmation and a clean explicitly marked recovery target", async () => {
    const common = {
      artifactPath,
      databaseUrl: source.url,
      expectedProjectRef: "",
      expectedDatabase: new URL(source.url).pathname.slice(1),
      allowDisposableLoopback: true,
      stdout: () => undefined,
    };
    await expect(restoreBackup({ ...common, confirmation: "WRONG", recoveryTarget: "recovery" }))
      .rejects.toThrow(`Exact confirmation ${RESTORE_CONFIRMATION} is required`);
    await expect(restoreBackup({ ...common, confirmation: RESTORE_CONFIRMATION, recoveryTarget: "development" }))
      .rejects.toThrow("Target must be explicitly marked as recovery");
    const output: string[] = [];
    await expect(restoreBackup({ ...common, confirmation: RESTORE_CONFIRMATION, recoveryTarget: "recovery",
      stdout: (message) => output.push(message) })).rejects.toThrow("Recovery target is not clean");
    expect(output).not.toContain("RESTORE_RESULT = PASS");
  });

  it("accepts only exact Supabase Direct and same-project Session Pooler identities", () => {
    const projectRef = "abcdefghijklmnopqrst";
    expect(validateDatabaseTarget(
      `postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres?sslmode=require`, projectRef,
    ).mode).toBe("DIRECT");
    expect(validateDatabaseTarget(
      `postgresql://postgres.${projectRef}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require`,
      projectRef,
    ).mode).toBe("SESSION_POOLER");
    expect(() => validateDatabaseTarget(
      `postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require`,
      projectRef,
    )).toThrow("does not match the expected Supabase project");
    expect(() => validateDatabaseTarget(
      `postgresql://postgres.${projectRef}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require`,
      projectRef,
    )).toThrow("administrative credentials are required");
  });

  it("records a checksum matching the exact archive bytes", async () => {
    expect(createHash("sha256").update(await readFile(artifactPath)).digest("hex"))
      .toBe(manifest.checksum.value);
  });
});
