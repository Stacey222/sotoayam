import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { startDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../../scripts/check-clean-migrations.js";

const fixtureHash = "scrypt$N=32768,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const requiredTaskPermissions = ["task.create", "task.view_assigned", "task.view_division", "task.update_assigned",
  "task.complete_assigned", "task.add_activity"];
const requiredBusinessPermissions = ["report.view_cross_division", "alert.view_critical", "alert.acknowledge",
  "approval.view", "approval.decide", "automation_status.view_business", "threshold.manage"];

describe("OWNER + SYSTEM_ADMIN MVP on disposable PostgreSQL", () => {
  let db: DisposablePostgresDatabase;
  let kentoId = 0;
  beforeAll(async () => {
    db = await startDisposablePostgresDatabase("sotoayam-owner-mvp-");
    kentoId = Number((await db.query(`select user_id from public.provision_first_installation(
      'Kento','owner@example.invalid','scrypt','${fixtureHash}','FRESH','OPERATIONS','Operations')`))[0]);
  }, 180_000);
  afterAll(async () => db?.close(), 30_000);

  it("adds exactly the required OWNER task capabilities without SYSTEM_ADMIN inheritance", async () => {
    const grants = (await db.query(`select p.code from public.role_permissions rp
      join public.roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
      where r.code='OWNER' order by p.code`));
    expect(grants).toEqual([...requiredTaskPermissions, ...requiredBusinessPermissions].sort());
    expect(grants).not.toContain("system_authority.manage");
  });

  it("moves the same effective SYSTEM_ADMIN to OWNER through the guarded access RPC", async () => {
    const roleId = Number((await db.query(`select id from public.roles where code='OWNER'`))[0]);
    const divisionId = Number((await db.query(`select division_id from public.users where id=${kentoId}`))[0]);
    await db.query(`select id from public.update_managed_user_access(${kentoId},${divisionId},${roleId},true,
      ${kentoId},'owner_mvp_test',false,'Owner onboarding')`);
    expect((await db.query(`select r.code from public.users u join public.roles r on r.id=u.role_id where u.id=${kentoId}`))[0]).toBe("OWNER");
    expect((await db.query(`select public.is_effective_system_admin(${kentoId})`))[0]).toBe("t");
    expect((await db.query(`select actor_type||'|'||actor_user_id from public.audit_logs
      where action='USER_ROLE_CHANGED' order by id desc limit 1`))[0]).toBe(`USER|${kentoId}`);
  });

  it("designates the same login-capable OWNER through the P2-01 RPC", async () => {
    expect((await db.query(`select public.is_business_actor_eligible(${kentoId})`))[0]).toBe("t");
    await db.query(`select business_actor_user_id from public.set_instance_business_actor(${kentoId},0,${kentoId},'Owner onboarding')`);
    expect((await db.query(`select business_actor_user_id from public.instance_settings`))[0]).toBe(String(kentoId));
    expect((await db.query(`select actor_type||'|'||actor_user_id from public.audit_logs
      where action='BUSINESS_ACTOR_CHANGED' order by id desc limit 1`))[0]).toBe(`USER|${kentoId}`);
  });
});

it("upgrades migration #22 to #23 without duplicate OWNER grants and reruns idempotently", async () => {
  const db = await startDisposablePostgresDatabase("sotoayam-owner-upgrade-", 22);
  try {
    const grants = async () => Number((await db.query(`select count(*) from public.role_permissions rp
      join public.roles r on r.id=rp.role_id where r.code='OWNER'`))[0]);
    expect(await grants()).toBe(7);
    const sql = await readFile("supabase/migrations/202609180001_add_owner_task_capabilities.sql", "utf8");
    await db.query(sql);
    expect(await grants()).toBe(13);
    await db.query(sql);
    expect(await grants()).toBe(13);
  } finally { await db.close(); }
}, 180_000);
