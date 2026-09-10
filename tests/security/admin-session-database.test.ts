import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const adminUrl = process.env.SOTOAYAM_TEST_POSTGRES_ADMIN_URL;
const psql = process.env.SOTOAYAM_TEST_PSQL ?? "psql";
const runDatabase = Boolean(adminUrl);
const databaseName = `sotoayam_p101_${process.pid}_${Date.now()}`;
const fixtureHash = "scrypt$N=32768,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
let userId = 0;

function databaseUrl(): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function sql(url: string, statement: string) {
  try {
    const { stdout, stderr } = await execute(psql, ["-d", url, "-v", "ON_ERROR_STOP=1", "-At", "-F", ",", "-c", statement],
      { maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout: stdout.trim(), stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: Number(failure.code ?? 1), stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
}

async function migrate(url: string): Promise<void> {
  const directory = path.resolve("supabase/migrations");
  const migrations = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  expect(migrations).toHaveLength(17);
  for (const migration of migrations) {
    await execute(psql, ["-d", url, "-v", "ON_ERROR_STOP=1", "-q", "-f", path.join(directory, migration)],
      { maxBuffer: 4 * 1024 * 1024 });
  }
}

function tokenHash(index: number): string {
  return createHash("sha256").update(`local-session-fixture-${index}`).digest("hex");
}

describe.skipIf(!runDatabase)("P1-01 disposable PostgreSQL session invariants", () => {
  beforeAll(async () => {
    const roles = `do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;`;
    expect((await sql(adminUrl!, roles)).code).toBe(0);
    expect((await sql(adminUrl!, `create database ${databaseName}`)).code).toBe(0);
    await migrate(databaseUrl());
    const provision = await sql(databaseUrl(), `select user_id from public.provision_first_installation(
      'Local Admin','admin@local.invalid','scrypt','${fixtureHash}','FRESH','OPERATIONS','Operations')`);
    expect(provision.code).toBe(0);
    userId = Number(provision.stdout);
  }, 60_000);

  afterAll(async () => { await sql(adminUrl!, `drop database if exists ${databaseName} with (force)`); }, 15_000);

  it("applies the service-only schema and eight definer functions", async () => {
    const result = await sql(databaseUrl(), `select
      (select count(*) from pg_tables where schemaname='public' and tablename in ('admin_sessions','admin_login_attempts')),
      (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in
        ('evaluate_admin_login_gate','record_admin_login_failure','create_admin_session','validate_admin_session',
         'revoke_admin_session','revoke_admin_sessions_for_user','change_admin_password','list_admin_sessions')),
      has_table_privilege('service_role','public.admin_sessions','select'),
      has_function_privilege('service_role','public.validate_admin_session(text,integer,integer)','execute')`);
    expect(result).toMatchObject({ code: 0, stdout: "2,8,f,t" });
  });

  it("validates hashes, throttles touches, and applies revocation immediately", async () => {
    const hash = tokenHash(1);
    const created = await sql(databaseUrl(), `select session_id from public.create_admin_session(
      ${userId},'${hash}','${tokenHash(101)}',43200,'127.0.0.1',null)`);
    expect(created.code).toBe(0);
    const sessionId = created.stdout;
    const seen = (await sql(databaseUrl(), `select last_seen_at from public.admin_sessions where id='${sessionId}'`)).stdout;
    expect((await sql(databaseUrl(), `select count(*) from public.validate_admin_session('${hash}',3600,60)`)).stdout).toBe("1");
    expect((await sql(databaseUrl(), `select last_seen_at from public.admin_sessions where id='${sessionId}'`)).stdout).toBe(seen);
    expect((await sql(databaseUrl(), `update public.admin_sessions set last_seen_at=now()-interval '61 seconds' where id='${sessionId}'`)).code).toBe(0);
    const stale = (await sql(databaseUrl(), `select last_seen_at from public.admin_sessions where id='${sessionId}'`)).stdout;
    expect((await sql(databaseUrl(), `select count(*) from public.validate_admin_session('${hash}',3600,60)`)).stdout).toBe("1");
    expect(Date.parse((await sql(databaseUrl(), `select last_seen_at from public.admin_sessions where id='${sessionId}'`)).stdout))
      .toBeGreaterThan(Date.parse(stale));
    expect((await sql(databaseUrl(), `select public.revoke_admin_session('${sessionId}','LOGOUT',${userId})`)).stdout).toBe("t");
    expect((await sql(databaseUrl(), `select count(*) from public.validate_admin_session('${hash}',3600,60)`)).stdout).toBe("0");
  });

  it("resets consecutive account failures after a successful login and enforces cooldown after five", async () => {
    expect((await sql(databaseUrl(), "delete from public.admin_login_attempts")).code).toBe(0);
    for (let index = 0; index < 4; index += 1) {
      expect((await sql(databaseUrl(), `select public.record_admin_login_failure(${userId},'127.0.0.1','BAD_PASSWORD')`)).code).toBe(0);
    }
    expect((await sql(databaseUrl(), `select session_id from public.create_admin_session(
      ${userId},'${tokenHash(200)}','${tokenHash(201)}',43200,'127.0.0.1',null)`)).code).toBe(0);
    for (let index = 0; index < 4; index += 1) {
      expect((await sql(databaseUrl(), `select public.record_admin_login_failure(${userId},'127.0.0.1','BAD_PASSWORD')`)).code).toBe(0);
    }
    expect((await sql(databaseUrl(), `select locked from public.evaluate_admin_login_gate(${userId},'127.0.0.1')`)).stdout).toBe("f");
    expect((await sql(databaseUrl(), `select public.record_admin_login_failure(${userId},'127.0.0.1','BAD_PASSWORD')`)).code).toBe(0);
    expect((await sql(databaseUrl(), `select locked from public.evaluate_admin_login_gate(${userId},'127.0.0.1')`)).stdout).toBe("t");
  });

  it("throttles UNKNOWN_EMAIL attempts per IP without locking a known account at that IP", async () => {
    expect((await sql(databaseUrl(), "delete from public.admin_login_attempts")).code).toBe(0);
    const ip = "127.0.0.2";
    const firstBatch = await sql(databaseUrl(), `select public.record_admin_login_failure(null,'${ip}','UNKNOWN_EMAIL')
      from generate_series(1,49)`);
    expect(firstBatch.code).toBe(0);
    expect((await sql(databaseUrl(), `select locked from public.evaluate_admin_login_gate(null,'${ip}')`)).stdout).toBe("f");
    expect((await sql(databaseUrl(), `select public.record_admin_login_failure(null,'${ip}','UNKNOWN_EMAIL')`)).code).toBe(0);
    expect((await sql(databaseUrl(), `select locked from public.evaluate_admin_login_gate(null,'${ip}')`)).stdout).toBe("t");
    expect((await sql(databaseUrl(), `select locked from public.evaluate_admin_login_gate(${userId},'${ip}')`)).stdout).toBe("f");
  });

  it("keeps the caller session on password change and revokes every other session", async () => {
    expect((await sql(databaseUrl(), "delete from public.admin_sessions")).code).toBe(0);
    const kept = (await sql(databaseUrl(), `select session_id from public.create_admin_session(
      ${userId},'${tokenHash(300)}','${tokenHash(301)}',43200,null,null)`)).stdout;
    const revoked = (await sql(databaseUrl(), `select session_id from public.create_admin_session(
      ${userId},'${tokenHash(302)}','${tokenHash(303)}',43200,null,null)`)).stdout;
    expect((await sql(databaseUrl(), `select public.change_admin_password(${userId},'scrypt','${fixtureHash}',${userId},'${kept}')`)).code).toBe(0);
    expect((await sql(databaseUrl(), `select (select revoked_at is null from public.admin_sessions where id='${kept}'),
      (select revoked_reason from public.admin_sessions where id='${revoked}')`)).stdout).toBe("t,PASSWORD_CHANGED");
  });

  it("rejects idle-expired, absolutely expired, and newly deactivated sessions", async () => {
    expect((await sql(databaseUrl(), "delete from public.admin_sessions")).code).toBe(0);
    const idleHash = tokenHash(350);
    const idle = (await sql(databaseUrl(), `select session_id from public.create_admin_session(
      ${userId},'${idleHash}','${tokenHash(351)}',43200,null,null)`)).stdout;
    expect((await sql(databaseUrl(), `update public.admin_sessions set last_seen_at=now()-interval '2 hours' where id='${idle}'`)).code).toBe(0);
    expect((await sql(databaseUrl(), `select count(*) from public.validate_admin_session('${idleHash}',3600,60)`)).stdout).toBe("0");

    const absoluteHash = tokenHash(352);
    const absolute = (await sql(databaseUrl(), `select session_id from public.create_admin_session(
      ${userId},'${absoluteHash}','${tokenHash(353)}',43200,null,null)`)).stdout;
    expect((await sql(databaseUrl(), `update public.admin_sessions set issued_at=now()-interval '2 hours',
      expires_at=now()-interval '1 hour' where id='${absolute}'`)).code).toBe(0);
    expect((await sql(databaseUrl(), `select count(*) from public.validate_admin_session('${absoluteHash}',3600,60)`)).stdout).toBe("0");

    const activeHash = tokenHash(354);
    expect((await sql(databaseUrl(), `select session_id from public.create_admin_session(
      ${userId},'${activeHash}','${tokenHash(355)}',43200,null,null)`)).code).toBe(0);
    const second = await sql(databaseUrl(), `with catalog as (
        select d.id division_id, r.id role_id from public.divisions d cross join public.roles r
        where d.code='OPERATIONS' and r.code='ADMIN'
      ), created as (
        insert into public.users(display_name,division_id,role_id,active)
        select 'Recovery Admin',division_id,role_id,true from catalog returning id
      ) insert into public.system_authority_assignments(user_id,authority_code,reason)
        select id,'SYSTEM_ADMIN','session test continuity' from created returning user_id`);
    expect(second.code).toBe(0);
    expect((await sql(databaseUrl(), `update public.users set active=false where id=${userId}`)).code).toBe(0);
    expect((await sql(databaseUrl(), `select count(*) from public.validate_admin_session('${activeHash}',3600,60)`)).stdout).toBe("0");
    expect((await sql(databaseUrl(), `update public.users set active=true where id=${userId}`)).code).toBe(0);
  });

  it("caps concurrent sessions at ten and audits security lifecycle events", async () => {
    expect((await sql(databaseUrl(), "delete from public.admin_sessions")).code).toBe(0);
    for (let index = 0; index < 11; index += 1) {
      expect((await sql(databaseUrl(), `select session_id from public.create_admin_session(
        ${userId},'${tokenHash(400 + index)}','${tokenHash(500 + index)}',43200,null,null)`)).code).toBe(0);
    }
    const state = await sql(databaseUrl(), `select count(*) filter (where revoked_at is null),
      count(*) filter (where revoked_reason='SUPERSEDED') from public.admin_sessions`);
    expect(state.stdout).toBe("10,1");
    const audit = await sql(databaseUrl(), `select count(distinct action) from public.audit_logs
      where action in ('ADMIN_LOGIN_SUCCEEDED','ADMIN_LOGIN_FAILED','ADMIN_LOGOUT','ADMIN_SESSION_REVOKED','ADMIN_PASSWORD_CHANGED')`);
    expect(audit.stdout).toBe("5");
  });
});
