import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const adminUrl = process.env.SOTOAYAM_TEST_POSTGRES_ADMIN_URL;
const psql = process.env.SOTOAYAM_TEST_PSQL ?? "psql";
const runDatabase = Boolean(adminUrl);
const databaseName = `sotoayam_p105_${process.pid}_${Date.now()}`;
const fixtureHash = "scrypt$N=32768,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
let actorId = 0;
let unauthorizedId = 0;

function databaseUrl(): string { const url = new URL(adminUrl!); url.pathname = `/${databaseName}`; return url.toString(); }
async function sql(statement: string, url = databaseUrl()) {
  try {
    const { stdout, stderr } = await execute(psql,
      ["-d", url, "-v", "ON_ERROR_STOP=1", "-At", "-F", ",", "-c", statement], { maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout: stdout.trim(), stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: Number(failure.code ?? 1), stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
}
async function reset(nextOffset: number) {
  expect((await sql(`truncate public.telegram_processed_updates;
    update public.telegram_polling_state set next_offset=${nextOffset},last_pruned_at=null
    where singleton_key='TELEGRAM_POLLING'`)).code).toBe(0);
}
async function claim(updateId: number, maxAttempts = 3, type = "message") {
  return (await sql(`select action,attempt_count from public.claim_telegram_update(${updateId},'${type}',${maxAttempts})`)).stdout;
}
async function complete(updateId: number, status = "COMPLETED", failure: string | null = null, retentionDays = 7) {
  return (await sql(`select public.complete_telegram_update(${updateId},'${status}',${failure === null ? "null" : `'${failure}'`},${retentionDays})`)).stdout;
}

describe.skipIf(!runDatabase)("P1-05 disposable PostgreSQL polling invariants", () => {
  beforeAll(async () => {
    const roles = `do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;`;
    expect((await sql(roles, adminUrl!)).code).toBe(0);
    expect((await sql(`create database ${databaseName}`, adminUrl!)).code).toBe(0);
    const directory = path.resolve("supabase/migrations");
    const migrations = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    expect(migrations).toHaveLength(18);
    for (const migration of migrations) await execute(psql,
      ["-d", databaseUrl(), "-v", "ON_ERROR_STOP=1", "-q", "-f", path.join(directory, migration)],
      { maxBuffer: 4 * 1024 * 1024 });
    const provisioned = await sql(`select user_id from public.provision_first_installation(
      'P105 Admin','p105@local.invalid','scrypt','${fixtureHash}','FRESH','OPERATIONS','Operations')`);
    expect(provisioned.code).toBe(0); actorId = Number(provisioned.stdout);
    const untrusted = await sql(`with created as (insert into public.users (display_name,division_id,role_id,active)
      select 'P105 Non Authority',users.division_id,users.role_id,true from public.users where id=${actorId} returning id)
      select id from created`);
    expect(untrusted.code).toBe(0); unauthorizedId = Number(untrusted.stdout);
  }, 60_000);

  afterAll(async () => { await sql(`drop database if exists ${databaseName} with (force)`, adminUrl!); }, 15_000);

  it("P5-13 leaves a never-claimed update fresh at the persisted offset", async () => {
    await reset(100);
    expect((await sql("select public.load_telegram_polling_state()" )).stdout).toBe("100");
    expect(await claim(100)).toBe("PROCESS,1");
  });

  it("P5-14 retries a PROCESSING update after handler-before-complete crash", async () => {
    await reset(200);
    expect(await claim(200)).toBe("PROCESS,1");
    expect((await sql("select public.load_telegram_polling_state()" )).stdout).toBe("200");
    expect(await claim(200)).toBe("PROCESS,2");
  });

  it("P5-15 commits terminal status and offset atomically", async () => {
    await reset(300); expect(await claim(300)).toBe("PROCESS,1");
    expect(await complete(300)).toBe("301");
    expect((await sql(`select updates.status,polling.next_offset from public.telegram_processed_updates updates
      cross join public.telegram_polling_state polling where updates.update_id=300`)).stdout).toBe("COMPLETED,301");
  });

  it("P5-16 never regresses the polling offset", async () => {
    await reset(1000); expect(await claim(900)).toBe("PROCESS,1");
    expect(await complete(900)).toBe("1000");
  });

  it("P5-25 leaves the higher update redeliverable after normalized [102,101] processing crashes", async () => {
    await reset(101);
    expect(await claim(101)).toBe("PROCESS,1");
    expect(await complete(101)).toBe("102");
    expect(await claim(102)).toBe("PROCESS,1");
    expect((await sql("select public.load_telegram_polling_state()" )).stdout).toBe("102");
    expect(await claim(102)).toBe("PROCESS,2");
  });

  it("P5-26 clamps completion to the lowest PROCESSING update", async () => {
    await reset(101); expect(await claim(101)).toBe("PROCESS,1"); expect(await claim(102)).toBe("PROCESS,1");
    expect(await complete(102)).toBe("101");
    expect(await complete(101, "FAILED", "HANDLER_ERROR")).toBe("102");
    expect(await complete(102)).toBe("103");
  });

  it("P5-27 makes force advance SYSTEM_ADMIN-only, forward-only, and audited", async () => {
    await reset(400);
    expect((await sql(`select public.force_advance_telegram_offset(450,'operator recovery',${unauthorizedId})`)).code).not.toBe(0);
    expect((await sql(`select public.force_advance_telegram_offset(400,'operator recovery',${actorId})`)).code).not.toBe(0);
    expect((await sql(`select public.force_advance_telegram_offset(399,'operator recovery',${actorId})`)).code).not.toBe(0);
    expect((await sql(`set role service_role; select public.force_advance_telegram_offset(450,'operator recovery',${actorId})`)).stdout)
      .toMatch(/450$/);
    const audit = await sql(`select count(*),bool_and(actor_type='USER'),bool_and(actor_user_id=${actorId}),
      bool_and(action='TELEGRAM_OFFSET_FORCE_ADVANCED') from public.audit_logs where action='TELEGRAM_OFFSET_FORCE_ADVANCED'`);
    expect(audit.stdout).toBe("1,t,t,t");
  });

  it("P5-17 skips a terminal duplicate without changing its evidence", async () => {
    await reset(500); expect(await claim(500)).toBe("PROCESS,1"); expect(await complete(500)).toBe("501");
    const before = (await sql("select status,attempt_count,completed_at from public.telegram_processed_updates where update_id=500")).stdout;
    expect(await claim(500)).toBe("SKIP_DUPLICATE,1");
    expect((await sql("select status,attempt_count,completed_at from public.telegram_processed_updates where update_id=500")).stdout).toBe(before);
  });

  it("P5-18 exhausts a stuck update at the configured attempt cap", async () => {
    await reset(600);
    expect(await claim(600)).toBe("PROCESS,1");
    expect(await claim(600)).toBe("PROCESS,2");
    expect(await claim(600)).toBe("PROCESS,3");
    expect(await claim(600)).toBe("SKIP_EXHAUSTED,4");
    expect((await sql("select status,attempt_count,failure_class from public.telegram_processed_updates where update_id=600")).stdout)
      .toBe("FAILED,4,ATTEMPTS_EXHAUSTED");
  });

  it("P5-19 prunes only eligible terminal rows and at most hourly", async () => {
    await reset(500);
    expect((await sql(`insert into public.telegram_processed_updates
      (update_id,status,attempt_count,update_type,failure_class,received_at,completed_at,updated_at) values
      (100,'COMPLETED',1,'message',null,now()-interval '10 days',now()-interval '10 days',now()-interval '10 days'),
      (550,'FAILED',1,'other','HANDLER_ERROR',now()-interval '10 days',now()-interval '10 days',now()-interval '10 days'),
      (200,'PROCESSING',1,'callback_query',null,now()-interval '10 days',null,now()-interval '10 days')`)).code).toBe(0);
    expect(await claim(600)).toBe("PROCESS,1"); expect(await complete(600, "COMPLETED", null, 7)).toBe("500");
    expect((await sql("select string_agg(update_id::text,',' order by update_id) from public.telegram_processed_updates")).stdout)
      .toBe("200,550,600");
    expect((await sql(`insert into public.telegram_processed_updates
      (update_id,status,attempt_count,update_type,received_at,completed_at,updated_at)
      values (50,'COMPLETED',1,'other',now()-interval '10 days',now()-interval '10 days',now()-interval '10 days')`)).code).toBe(0);
    expect(await claim(601)).toBe("PROCESS,1"); await complete(601, "COMPLETED", null, 7);
    expect((await sql("select count(*) from public.telegram_processed_updates where update_id=50")).stdout).toBe("1");
  });

  it("P5-20 denies direct service_role table writes while allowing RPC access", async () => {
    await reset(700);
    expect((await sql("set role service_role; select * from public.telegram_polling_state")).code).not.toBe(0);
    expect((await sql("set role service_role; select * from public.telegram_processed_updates")).code).not.toBe(0);
    expect((await sql("set role service_role; insert into public.telegram_polling_state(singleton_key) values('TELEGRAM_POLLING')")).code).not.toBe(0);
    expect((await sql("set role service_role; insert into public.telegram_processed_updates(update_id,status,update_type) values(700,'PROCESSING','message')")).code).not.toBe(0);
    expect((await sql("set role service_role; update public.telegram_polling_state set next_offset=701")).code).not.toBe(0);
    expect((await sql("set role service_role; update public.telegram_processed_updates set status='FAILED'")).code).not.toBe(0);
    expect((await sql("set role service_role; select public.load_telegram_polling_state()" )).stdout).toMatch(/700$/);
    expect((await sql("set role service_role; select action,attempt_count from public.claim_telegram_update(700,'message',3)" )).stdout)
      .toMatch(/PROCESS,1$/);
    expect((await sql("set role service_role; select public.complete_telegram_update(700,'COMPLETED',null)" )).stdout)
      .toMatch(/701$/);
  });
});
