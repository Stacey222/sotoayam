import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { startDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../../scripts/check-clean-migrations.js";

const fixtureHash = "scrypt$N=32768,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

describe("development reset on disposable PostgreSQL", () => {
  let db: DisposablePostgresDatabase;
  let kentoId: string;
  let resetSql: string;
  beforeAll(async () => {
    db = await startDisposablePostgresDatabase("sotoayam-dev-reset-");
    resetSql = await readFile("scripts/sql/dev-reset-data.sql", "utf8");
    kentoId = (await db.query(`select user_id from public.provision_first_installation(
      'Kento','owner@sotoayam.local','scrypt','${fixtureHash}',
      'FRESH','OPERATIONS','Operations')`))[0]!;
    const divisionId = (await db.query(`select division_id from public.users where id=${kentoId}`))[0]!;
    const ownerRoleId = (await db.query("select id from public.roles where code='OWNER'"))[0]!;
    const legacyId = (await db.query(`insert into public.users(display_name,division_id,role_id,active)
      values('Legacy Owner',${divisionId},${ownerRoleId},true) returning id`))[0]!;
    await db.query(`insert into public.admin_credentials(user_id,email,password_algorithm,password_hash)
      values(${legacyId},'legacy@example.invalid','scrypt','${fixtureHash}')`);
    const telegramId = (await db.query(`insert into public.telegram_users(telegram_chat_id)
      values(900000001) returning id`))[0]!;
    await db.query(`update public.users set legacy_telegram_user_id=${telegramId} where id=${legacyId}`);
    await db.query(`insert into public.user_channels(user_id,channel_type,external_id)
      values(${legacyId},'TELEGRAM','900000001')`);
    await db.query(`insert into public.tasks(title,created_by_user_id,requesting_division_id,
      owner_division_id,assigned_to_user_id) values('Legacy task',${legacyId},${divisionId},
      ${divisionId},${legacyId})`);
  }, 180_000);
  afterAll(async () => db?.close(), 30_000);

  it("rolls back role, settings, user and task changes on a forced late failure", async () => {
    const forcedFailure = resetSql.replace("commit;", "do $$ begin raise exception 'FORCED_RESET_FAILURE'; end $$;\ncommit;");
    await expect(db.query(forcedFailure)).rejects.toThrow();
    expect((await db.query("select count(*) from public.users"))[0]).toBe("2");
    expect((await db.query("select count(*) from public.tasks"))[0]).toBe("1");
    expect((await db.query(`select r.code from public.users u join public.roles r on r.id=u.role_id
      where u.id=${kentoId}`))[0]).toBe("ADMIN");
    expect((await db.query("select business_actor_user_id is null from public.instance_settings"))[0]).toBe("t");
  });

  it("keeps only Kento, preserves reference/settings/bootstrap and clears operational data", async () => {
    const before = (await db.query(`select
      (select count(*) from public.divisions),
      (select count(*) from public.roles),
      (select count(*) from public.permissions),
      (select count(*) from public.task_categories),
      (select count(*) from public.installation_provenance),
      (select business_time_zone from public.instance_settings)`))[0];
    await db.query(resetSql);
    expect((await db.query(`select
      (select count(*) from public.users),
      (select count(*) from public.admin_credentials),
      (select count(*) from public.telegram_users),
      (select count(*) from public.user_channels),
      (select count(*) from public.tasks),
      (select count(*) from public.audit_logs)`))[0]).toBe("1|1|0|0|0|3");
    expect((await db.query(`select
      (select count(*) from public.divisions),
      (select count(*) from public.roles),
      (select count(*) from public.permissions),
      (select count(*) from public.task_categories),
      (select count(*) from public.installation_provenance),
      (select business_time_zone from public.instance_settings)`))[0]).toBe(before);
    expect((await db.query(`select
      (select count(*) from public.users u join public.roles r on r.id=u.role_id where r.code='OWNER'),
      (select count(*) from public.system_authority_assignments where revoked_at is null),
      (select business_actor_user_id from public.instance_settings),
      (select first_admin_user_id from public.instance_bootstrap),
      public.is_effective_system_admin(${kentoId})`))[0]).toBe(`1|1|${kentoId}|${kentoId}|t`);
    const fkViolations = await db.query(`select count(*) from pg_constraint c
      where c.contype='f' and c.connamespace='public'::regnamespace and not c.convalidated`);
    expect(fkViolations[0]).toBe("0");
  });

  it("seeds only two fake email identities without Telegram or extra authority", async () => {
    const template = await readFile("scripts/sql/dev-seed-dummy.sql", "utf8");
    const sql = template.replace("__DUMMY_USER_HASH__", fixtureHash)
      .replace("__DUMMY_ADMIN_HASH__", fixtureHash);
    await db.query(sql);
    expect((await db.query(`select array_agg(email order by email)::text from public.admin_credentials`))[0])
      .toBe("{dummy.admin@example.invalid,dummy.user@example.invalid,owner@sotoayam.local}");
    expect((await db.query(`select count(*) from public.telegram_users`))[0]).toBe("0");
    expect((await db.query(`select count(*) from public.user_channels`))[0]).toBe("0");
    expect((await db.query(`select count(*) from public.system_authority_assignments where revoked_at is null`))[0]).toBe("1");
  });
});
