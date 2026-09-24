import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/auth/admin-password.js";
import { startDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../../scripts/check-clean-migrations.js";

const fixturePassword = "0123456789abcdef";
const policy = `'${JSON.stringify({ overdue: { warningHours: 1, highHours: 24, criticalHours: 72 },
  blocked: { warningHours: 4, highHours: 24, criticalHours: 72 },
  scheduler: { staleMinutes: 15, criticalMinutes: 60 } })}'::jsonb`;
let db: DisposablePostgresDatabase;
let fixtureHash = "";
const scalar = async (sql: string) => (await db.query(sql))[0]!;
const provision = (name: string, email: string, alertPolicy = policy) => `select * from public.provision_first_owner(
  '${name}','${email}','scrypt','${fixtureHash}','OPERATIONS','Operations','Asia/Jakarta',300,${alertPolicy})`;

describe("P3-01 disposable PostgreSQL first-owner bootstrap", () => {
  beforeAll(async () => {
    fixtureHash = await hashPassword(fixturePassword);
    db = await startDisposablePostgresDatabase("sotoayam-p301-");
  }, 180_000);
  afterAll(async () => db?.close(), 30_000);

  it("clean install has no customer, credential, Telegram, or development identity", async () => {
    expect(await scalar(`select (select count(*) from public.users)||'|'||(select count(*) from public.admin_credentials)||'|'
      ||(select count(*) from public.telegram_users)||'|'||(select count(*) from public.instance_bootstrap)`)).toBe("0|0|0|0");
    expect(await scalar(`select count(*) from public.users u left join public.admin_credentials c on c.user_id=u.id
      where lower(coalesce(c.email,''))='owner@sotoayam.local' or lower(u.display_name)='kento'`)).toBe("0");
  });

  it("a failure after base provisioning rolls the entire transaction back", async () => {
    const failed = await db.attempt(provision("Rollback Owner", "rollback@example.test", `'{}'::jsonb`));
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("VALIDATION_ERROR");
    expect(await scalar(`select (select count(*) from public.users)||'|'||(select count(*) from public.admin_credentials)||'|'
      ||(select count(*) from public.system_authority_assignments)||'|'||(select count(*) from public.instance_bootstrap)||'|'
      ||(select business_actor_user_id is null from public.instance_settings)`)).toBe("0|0|0|0|true");
  });

  it("concurrent attempts serialize and produce exactly one complete first OWNER", async () => {
    const attempts = await Promise.all([
      db.attempt(provision("First Owner", "first-owner@example.test")),
      db.attempt(provision("Second Owner", "second-owner@example.test")),
    ]);
    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.ok)[0]?.error).toContain("FIRST_ADMIN_ALREADY_EXISTS");
    expect(await scalar(`select count(*) from public.users`)).toBe("1");
    expect(await scalar(`select r.code||'|'||u.active||'|'||d.active||'|'||d.grants_system_authority||'|'
      ||(a.id is not null)::text||'|'||(s.business_actor_user_id=u.id)::text||'|'||(b.first_admin_user_id=u.id)::text||'|'
      ||c.password_change_required::text
      from public.users u join public.roles r on r.id=u.role_id join public.divisions d on d.id=u.division_id
      join public.admin_credentials c on c.user_id=u.id
      left join public.system_authority_assignments a on a.user_id=u.id and a.authority_code='SYSTEM_ADMIN' and a.revoked_at is null
      cross join public.instance_settings s cross join public.instance_bootstrap b`)).toBe("OWNER|true|true|true|true|true|true|false");
  });

  it("stores a usable scrypt credential and rejects a second bootstrap", async () => {
    const hash = await scalar(`select password_hash from public.admin_credentials`);
    await expect(verifyPassword(fixturePassword, hash)).resolves.toBe(true);
    const replay = await db.attempt(provision("Replay Owner", "replay@example.test"));
    expect(replay.ok).toBe(false);
    expect(replay.error).toContain("FIRST_ADMIN_ALREADY_EXISTS");
    expect(await scalar(`select count(*) from public.users`)).toBe("1");
  });

  it("keeps the RPC service-role-only and records explicit authority and OWNER audit evidence", async () => {
    expect(await scalar(`select has_function_privilege('service_role','public.provision_first_owner(text,text,text,text,text,text,text,integer,jsonb)','EXECUTE')||'|'
      ||has_function_privilege('anon','public.provision_first_owner(text,text,text,text,text,text,text,integer,jsonb)','EXECUTE')||'|'
      ||has_function_privilege('authenticated','public.provision_first_owner(text,text,text,text,text,text,text,integer,jsonb)','EXECUTE')`)).toBe("true|false|false");
    expect(await scalar(`select count(*) from public.audit_logs where action='FIRST_OWNER_BOOTSTRAPPED'
      and actor_type='USER' and actor_user_id=(select id from public.users)`)).toBe("1");
  });
});
