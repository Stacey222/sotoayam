import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../../scripts/check-clean-migrations.js";
import { readFile } from "node:fs/promises";
import { DEFAULT_CRITICAL_ALERT_POLICY } from "../../src/alerts/policy.js";
import type { RuntimeSettingsRecord, RuntimeSettingsRepository } from "../../src/repositories/runtime-settings.repository.js";
import { RuntimeSettingsProvider } from "../../src/runtime/runtime-settings.js";
import { RuntimeSettingsService } from "../../src/services/runtime-settings.service.js";

const fixtureHash = "scrypt$N=32768,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const policy = `'{"overdue":{"warningHours":1,"highHours":24,"criticalHours":72},"blocked":{"warningHours":4,"highHours":24,"criticalHours":72},"scheduler":{"staleMinutes":15,"criticalMinutes":60}}'::jsonb`;
let db: DisposablePostgresDatabase; let adminId = 0; let ownerId = 0; let secondOwnerId = 0; let ownerDivisionId = 0;
const scalar = async (sql: string) => (await db.query(sql))[0]!;

describe("P2-01 disposable PostgreSQL runtime settings and OWNER invariants", () => {
  beforeAll(async () => {
    db = await startDisposablePostgresDatabase("sotoayam-p201-");
    adminId = Number(await scalar(`select user_id from public.provision_first_installation(
      'P201 Admin','p201-admin@example.test','scrypt','${fixtureHash}','FRESH','OPERATIONS','Operations')`));
    ownerDivisionId = Number(await scalar(`insert into public.divisions(code,name,active,grants_system_authority)
      values('BUSINESS_OWNER','Business Owner',true,false) returning id`));
    ownerId = Number(await scalar(`insert into public.users(display_name,division_id,role_id,active) values
      ('P201 Owner',${ownerDivisionId},(select id from public.roles where code='OWNER'),true) returning id`));
    await db.query(`insert into public.admin_credentials(user_id,email,password_algorithm,password_hash,password_change_required)
      values(${ownerId},'p201-owner@example.test','scrypt','${fixtureHash}',false)`);
    secondOwnerId = Number(await scalar(`insert into public.users(display_name,division_id,role_id,active) values
      ('P201 Owner Two',${ownerDivisionId},(select id from public.roles where code='OWNER'),true) returning id`));
    await db.query(`insert into public.admin_credentials(user_id,email,password_algorithm,password_hash,password_change_required)
      values(${secondOwnerId},'p201-owner-two@example.test','scrypt','${fixtureHash}',false)`);
  }, 180_000);
  afterAll(async () => db?.close(), 30_000);

  it("O-12 leaves first ADMIN + SYSTEM_ADMIN without OWNER designation", async () => {
    expect(await scalar(`select r.code||'|'||(exists(select 1 from public.system_authority_assignments a where a.user_id=u.id and a.revoked_at is null))::text
      from public.users u join public.roles r on r.id=u.role_id where u.id=${adminId}`)).toBe("ADMIN|true");
    expect(await scalar(`select business_actor_user_id is null from public.instance_settings`)).toBe("t");
  });
  it("O-09 rejects missing credential/password-change-required designation targets", async () => {
    const noLogin = Number(await scalar(`insert into public.users(display_name,division_id,role_id,active) values
      ('No Login',${ownerDivisionId},(select id from public.roles where code='OWNER'),true) returning id`));
    expect((await db.attempt(`select * from public.set_instance_business_actor(${adminId},0,${noLogin},'invalid target')`)).error).toContain("BUSINESS_ACTOR_INELIGIBLE");
    await db.query(`update public.admin_credentials set password_change_required=true where user_id=${secondOwnerId}`);
    expect((await db.attempt(`select * from public.set_instance_business_actor(${adminId},0,${secondOwnerId},'invalid target')`)).error).toContain("BUSINESS_ACTOR_INELIGIBLE");
    await db.query(`update public.admin_credentials set password_change_required=false where user_id=${secondOwnerId}`);
    const inactiveUser = Number(await scalar(`insert into public.users(display_name,division_id,role_id,active) values
      ('Inactive Owner',${ownerDivisionId},(select id from public.roles where code='OWNER'),false) returning id`));
    await db.query(`insert into public.admin_credentials(user_id,email,password_algorithm,password_hash,password_change_required)
      values(${inactiveUser},'inactive-owner@example.test','scrypt','${fixtureHash}',false)`);
    const adminRoleUser = Number(await scalar(`insert into public.users(display_name,division_id,role_id,active) values
      ('Wrong Role',${ownerDivisionId},(select id from public.roles where code='ADMIN'),true) returning id`));
    await db.query(`insert into public.admin_credentials(user_id,email,password_algorithm,password_hash,password_change_required)
      values(${adminRoleUser},'wrong-role@example.test','scrypt','${fixtureHash}',false)`);
    const inactiveDivision = Number(await scalar(`insert into public.divisions(code,name,active,grants_system_authority)
      values('OWNER_DISABLED','Disabled Owner',false,false) returning id`));
    const inactiveDivisionUser = Number(await scalar(`insert into public.users(display_name,division_id,role_id,active) values
      ('Disabled Division Owner',${inactiveDivision},(select id from public.roles where code='OWNER'),true) returning id`));
    await db.query(`insert into public.admin_credentials(user_id,email,password_algorithm,password_hash,password_change_required)
      values(${inactiveDivisionUser},'disabled-division@example.test','scrypt','${fixtureHash}',false)`);
    const incompleteRole = Number(await scalar(`insert into public.roles(code,name,active,system_managed) values('OWNER_LIMITED','Owner Limited',true,false) returning id`));
    await db.query(`insert into public.role_permissions(role_id,permission_id) select ${incompleteRole},id from public.permissions
      where code in ('report.view_cross_division','alert.view_critical','alert.acknowledge','approval.view','approval.decide','automation_status.view_business')`);
    const incompleteUser = Number(await scalar(`insert into public.users(display_name,division_id,role_id,active) values
      ('Incomplete Owner',${ownerDivisionId},${incompleteRole},true) returning id`));
    await db.query(`insert into public.admin_credentials(user_id,email,password_algorithm,password_hash,password_change_required)
      values(${incompleteUser},'incomplete-owner@example.test','scrypt','${fixtureHash}',false)`);
    const inactiveRole = Number(await scalar(`insert into public.roles(code,name,active,system_managed) values('OWNER_INACTIVE','Owner Inactive',false,false) returning id`));
    await db.query(`insert into public.role_permissions(role_id,permission_id) select ${inactiveRole},id from public.permissions
      where code in ('report.view_cross_division','alert.view_critical','alert.acknowledge','approval.view','approval.decide','automation_status.view_business','threshold.manage')`);
    const inactiveRoleUser = Number(await scalar(`insert into public.users(display_name,division_id,role_id,active) values
      ('Inactive Role Owner',${ownerDivisionId},${inactiveRole},true) returning id`));
    await db.query(`insert into public.admin_credentials(user_id,email,password_algorithm,password_hash,password_change_required)
      values(${inactiveRoleUser},'inactive-role@example.test','scrypt','${fixtureHash}',false)`);
    for (const id of [inactiveUser, adminRoleUser, inactiveDivisionUser, incompleteUser, inactiveRoleUser]) {
      expect((await db.attempt(`select * from public.set_instance_business_actor(${adminId},0,${id},'invalid target')`)).error).toContain("BUSINESS_ACTOR_INELIGIBLE");
    }
  }, 30_000);
  it("O-08 designates an eligible OWNER with real USER audit attribution", async () => {
    expect((await db.query(`select business_actor_user_id from public.set_instance_business_actor(${adminId},0,${ownerId},'initial owner')`))[0]).toBe(String(ownerId));
    expect(await scalar(`select actor_type||'|'||actor_user_id from public.audit_logs where action='BUSINESS_ACTOR_CHANGED' order by id desc limit 1`)).toBe(`USER|${adminId}`);
  });
  it("S-02/S-06 atomically persists a complete snapshot and sanitized audit", async () => {
    await db.query(`select * from public.update_instance_runtime_settings(${ownerId},1,'Asia/Jakarta',120,${policy},'operational update')`);
    expect(await scalar(`select business_time_zone||'|'||reminder_scheduler_interval_seconds||'|'||version from public.instance_settings`)).toBe("Asia/Jakarta|120|2");
    expect(await scalar(`select actor_type||'|'||actor_user_id||'|'||source from public.audit_logs where action='RUNTIME_SETTINGS_UPDATED' order by id desc limit 1`)).toBe(`USER|${ownerId}|runtime_settings_api`);
  });
  it("S-07 stale version loses without changing the winning snapshot", async () => {
    const failed = await db.attempt(`select * from public.update_instance_runtime_settings(${ownerId},1,'UTC',300,${policy},'stale')`);
    expect(failed.ok).toBe(false); expect(failed.error).toContain("SETTINGS_VERSION_CONFLICT");
    expect(await scalar(`select business_time_zone||'|'||version from public.instance_settings`)).toBe("Asia/Jakarta|2");
  });
  it("S-04/S-05 enforces cadence and policy validation in PostgreSQL", async () => {
    expect((await db.attempt(`select * from public.update_instance_runtime_settings(${ownerId},2,'UTC',59,${policy},'bad cadence')`)).ok).toBe(false);
    expect((await db.attempt(`select * from public.update_instance_runtime_settings(${ownerId},2,'UTC',300,'{}'::jsonb,'bad policy')`)).ok).toBe(false);
  });
  it("O-10 blocks deactivation, role/division move, and division deactivation of the designation", async () => {
    const inactiveDivision = Number(await scalar(`insert into public.divisions(code,name,active,grants_system_authority)
      values('INACTIVE_OWNER','Inactive Owner',false,false) returning id`));
    for (const statement of [`update public.users set active=false where id=${ownerId}`,
      `update public.users set role_id=(select id from public.roles where code='ADMIN') where id=${ownerId}`,
      `update public.users set division_id=${inactiveDivision} where id=${ownerId}`,
      `update public.divisions set active=false where id=${ownerDivisionId}`]) {
      const result = await db.attempt(statement); expect(result.ok).toBe(false); expect(result.error).toContain("LAST_OWNER");
    }
    expect(await scalar(`select public.is_business_actor_eligible(${ownerId})`)).toBe("t");
  });
  it("O-11 serializes replacement and destructive access change without an invalid commit", async () => {
    const version = Number(await scalar(`select version from public.instance_settings`));
    const [replace, deactivate] = await Promise.all([
      db.attempt(`select * from public.set_instance_business_actor(${adminId},${version},${secondOwnerId},'handoff')`),
      db.attempt(`update public.users set active=false where id=${ownerId}`),
    ]);
    expect(replace.ok || deactivate.ok).toBe(true);
    expect(await scalar(`select public.is_business_actor_eligible(business_actor_user_id) from public.instance_settings`)).toBe("t");
  });
  it("M-01 exposes only service-role RPC access with deny-all RLS", async () => {
    expect(await scalar(`select relrowsecurity from pg_class where oid='public.instance_settings'::regclass`)).toBe("t");
    expect(await scalar(`select has_table_privilege('anon','public.instance_settings','select') or has_table_privilege('authenticated','public.instance_settings','select')`)).toBe("f");
    expect(await scalar(`select has_function_privilege('service_role','public.get_instance_settings()','execute')`)).toBe("t");
  });
  it("S-08 rejects an unchanged snapshot without state, audit, or runtime reload mutation", async () => {
    const getRecord = async (): Promise<RuntimeSettingsRecord> => JSON.parse(await scalar(
      `select row_to_json(settings)::text from public.get_instance_settings() settings`,
    )) as RuntimeSettingsRecord;
    const repository: RuntimeSettingsRepository = {
      get: getRecord,
      async updateRuntime(input) {
        const result = await db.attempt(`select * from public.update_instance_runtime_settings(
          ${input.actorUserId},${input.expectedVersion},'${input.businessTimeZone}',${input.reminderSchedulerIntervalSeconds},
          '${JSON.stringify(input.criticalAlertPolicy)}'::jsonb,'${input.reason}')`);
        if (!result.ok) throw new Error(result.error);
        return getRecord();
      },
      async setBusinessActor() { throw new Error("not used by this test"); },
    };
    const baseline = { businessTimeZone: "UTC", reminderSchedulerIntervalSeconds: 300,
      criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY };
    const provider = new RuntimeSettingsProvider(baseline);
    const service = new RuntimeSettingsService(repository, provider, baseline);
    await service.load();
    const reload = vi.fn(); service.setIntervalUpdater(reload);
    const runtimeOwnerId = Number(await scalar(`select business_actor_user_id from public.instance_settings`));
    const runtimeOwner = { id: runtimeOwnerId, displayName: "P201 Active Owner", active: true,
      divisionId: ownerDivisionId, divisionCode: "BUSINESS_OWNER", divisionActive: true, roleId: 0,
      roleCode: "OWNER", roleActive: true, permissions: new Set(["threshold.manage"]) };
    const startingVersion = Number(await scalar(`select version from public.instance_settings`));
    const input = { expectedVersion: startingVersion, businessTimeZone: "UTC", reminderSchedulerIntervalSeconds: 180,
      criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY, reason: "apply distinct snapshot" };
    const applied = await service.updateRuntime(runtimeOwner, input);
    expect(reload).toHaveBeenCalledTimes(1);

    const stateAfterApply = await scalar(`select row_to_json(settings)::text from public.instance_settings settings`);
    const auditCountAfterApply = await scalar(`select count(*) from public.audit_logs where action='RUNTIME_SETTINGS_UPDATED'`);
    await expect(service.updateRuntime(runtimeOwner, {
      ...input, expectedVersion: applied.version, reason: "reject identical snapshot",
    })).rejects.toMatchObject({ code: "SETTINGS_UNCHANGED" });

    expect(await scalar(`select row_to_json(settings)::text from public.instance_settings settings`)).toBe(stateAfterApply);
    expect(await scalar(`select count(*) from public.audit_logs where action='RUNTIME_SETTINGS_UPDATED'`)).toBe(auditCountAfterApply);
    expect(await scalar(`select version from public.instance_settings`)).toBe(String(applied.version));
    expect(reload).toHaveBeenCalledTimes(1);
  }, 20_000);
  it("O-12 upgrade backfill handles zero, one, and multiple eligible OWNER users without ambiguity", async () => {
    const migration = await readFile("supabase/migrations/202609150001_create_runtime_settings_owner_actors.sql", "utf8");
    const upgrade = await startDisposablePostgresDatabase("sotoayam-p201-upgrade-", 20);
    try {
      const first = Number((await upgrade.query(`select user_id from public.provision_first_installation(
        'Upgrade Admin','upgrade-admin@example.test','scrypt','${fixtureHash}','FRESH','OPERATIONS','Operations')`))[0]);
      const created: number[] = [];
      for (const count of [0, 1, 2]) {
        while (created.length < count) {
          const index = created.length;
          const id = Number((await upgrade.query(`insert into public.users(display_name,division_id,role_id,active) select
            'Upgrade Owner ${count}-${index}',division_id,(select id from public.roles where code='OWNER'),true from public.users where id=${first} returning id`))[0]);
          await upgrade.query(`insert into public.admin_credentials(user_id,email,password_algorithm,password_hash,password_change_required)
            values(${id},'upgrade-owner-${count}-${index}@example.test','scrypt','${fixtureHash}',false)`); created.push(id);
        }
        await upgrade.query(migration);
        const selected = (await upgrade.query(`select coalesce(business_actor_user_id::text,'NULL') from public.instance_settings`))[0];
        expect(selected).toBe(count === 1 ? String(created[0]) : "NULL");
        if (count < 2) await upgrade.query(`
          drop trigger protect_designated_business_actor_user on public.users;
          drop trigger protect_designated_business_actor_division on public.divisions;
          drop trigger protect_designated_business_actor_credential on public.admin_credentials;
          drop function public.protect_designated_business_actor_user();
          drop function public.protect_designated_business_actor_division();
          drop function public.protect_designated_business_actor_credential();
          drop function public.update_instance_runtime_settings(bigint,bigint,text,integer,jsonb,text);
          drop function public.set_instance_business_actor(bigint,bigint,bigint,text);
          drop function public.get_instance_settings();
          drop function public.is_business_actor_eligible(bigint);
          drop function public._business_actor_state_eligible(bigint,boolean,bigint,bigint);
          drop function public.is_valid_critical_alert_policy(jsonb);
          drop table public.instance_settings;
          delete from public.role_permissions where role_id=(select id from public.roles where code='OWNER')
            and permission_id=(select id from public.permissions where code='threshold.manage');`);
      }
    } finally { await upgrade.close(); }
  }, 120_000);
});
