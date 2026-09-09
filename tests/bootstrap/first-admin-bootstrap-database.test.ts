import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const adminUrl = process.env.SOTOAYAM_TEST_POSTGRES_ADMIN_URL;
const psql = process.env.SOTOAYAM_TEST_PSQL ?? "psql";
const runLive = Boolean(adminUrl);
const prefix = `sotoayam_p012_${process.pid}_${Date.now()}`;
const databaseNames = {
  success: `${prefix}_success`,
  rollback: `${prefix}_rollback`,
  concurrent: `${prefix}_concurrent`,
  structural: `${prefix}_structural`,
};
const hash = "scrypt$N=32768,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

function databaseUrl(name: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function sql(url: string, statement: string, stopOnError = true) {
  try {
    const { stdout, stderr } = await execute(psql, ["-d", url, "-v", `ON_ERROR_STOP=${stopOnError ? "1" : "0"}`, "-At", "-F", ",", "-c", statement], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: Number(failure.code ?? 1), stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
}

async function migrate(url: string): Promise<void> {
  const directory = path.resolve(process.cwd(), "supabase/migrations");
  const migrations = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await execute(psql, ["-d", url, "-v", "ON_ERROR_STOP=1", "-q", "-f", path.join(directory, migration)], {
      maxBuffer: 4 * 1024 * 1024,
    });
  }
}

function bootstrapSql(name: string, email: string): string {
  return `select * from public.bootstrap_first_admin('${name}','${email}','scrypt','${hash}');`;
}

describe.skipIf(!runLive)("first-administrator PostgreSQL invariants", () => {
  beforeAll(async () => {
    const roles = `do $$ begin
      create role anon nologin;
    exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin;
    exception when duplicate_object then null; end $$;
    do $$ begin create role service_role nologin bypassrls;
    exception when duplicate_object then null; end $$;`;
    expect((await sql(adminUrl!, roles)).code).toBe(0);
    for (const name of Object.values(databaseNames)) {
      expect((await sql(adminUrl!, `create database ${name}`)).code).toBe(0);
      await migrate(databaseUrl(name));
    }
  }, 120_000);

  afterAll(async () => {
    for (const name of Object.values(databaseNames)) {
      await sql(adminUrl!, `drop database if exists ${name} with (force)`);
    }
  }, 30_000);

  it("creates exactly one complete, Telegram-independent, audited administrator", async () => {
    const url = databaseUrl(databaseNames.success);
    const first = await sql(url, bootstrapSql("Ada Installer", " Admin@Example.COM "));
    expect(first.code).toBe(0);
    const state = await sql(url, `select
      (select count(*) from public.users),
      (select count(*) from public.admin_credentials),
      (select count(*) from public.system_authority_assignments where authority_code='SYSTEM_ADMIN' and revoked_at is null),
      (select count(*) from public.instance_bootstrap),
      (select count(*) from public.audit_logs where action='FIRST_ADMIN_BOOTSTRAPPED'),
      (select count(*) from public.user_channels),
      (select count(*) from public.telegram_users),
      (select count(*) from public.users u join public.roles r on r.id=u.role_id where r.code='OWNER');`);
    expect(state.stdout.trim()).toBe("1,1,1,1,1,0,0,0");
    const identity = await sql(url, `select u.active,d.code,r.code,u.legacy_telegram_user_id is null,c.email,
      a.authority_code,a.revoked_at is null,a.granted_by_user_id is null
      from public.users u join public.divisions d on d.id=u.division_id join public.roles r on r.id=u.role_id
      join public.admin_credentials c on c.user_id=u.id
      join public.system_authority_assignments a on a.user_id=u.id;`);
    expect(identity.stdout.trim()).toBe("t,IT,ADMIN,t,admin@example.com,SYSTEM_ADMIN,t,t");
    const audit = await sql(url, `select actor_type,source,after_state ? 'email',after_state ? 'password',
      after_state->>'authority_code',after_state->>'division_code',after_state->>'role_code',
      after_state->>'credential_algorithm',after_state->>'telegram_identity_present'
      from public.audit_logs where action='FIRST_ADMIN_BOOTSTRAPPED';`);
    expect(audit.stdout.trim()).toBe("SYSTEM,first_admin_bootstrap,f,f,SYSTEM_ADMIN,IT,ADMIN,scrypt,false");
  });

  it("permanently rejects a second bootstrap without changing counts", async () => {
    const url = databaseUrl(databaseNames.success);
    const before = await sql(url, "select (select count(*) from users),(select count(*) from admin_credentials),(select count(*) from system_authority_assignments),(select count(*) from instance_bootstrap),(select count(*) from audit_logs);");
    const second = await sql(url, bootstrapSql("Second Installer", "second@example.com"));
    const after = await sql(url, "select (select count(*) from users),(select count(*) from admin_credentials),(select count(*) from system_authority_assignments),(select count(*) from instance_bootstrap),(select count(*) from audit_logs);");
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("FIRST_ADMIN_ALREADY_EXISTS");
    expect(after.stdout).toBe(before.stdout);
  });

  it("does not re-arm after the first administrator is deactivated or its authority is revoked", async () => {
    const url = databaseUrl(databaseNames.success);
    expect((await sql(url, `alter table public.users disable trigger protect_final_system_admin_user_access;
      update public.users set active=false;
      alter table public.users enable trigger protect_final_system_admin_user_access;`)).code).toBe(0);
    const afterDeactivation = await sql(url, bootstrapSql("Replacement", "replacement@example.com"));
    expect(afterDeactivation.stderr).toContain("FIRST_ADMIN_ALREADY_EXISTS");
    expect((await sql(url, "update public.users set active=true;")).code).toBe(0);
    expect((await sql(url, `alter table public.system_authority_assignments disable trigger protect_final_system_admin_assignment;
      update public.system_authority_assignments set revoked_at=now();
      alter table public.system_authority_assignments enable trigger protect_final_system_admin_assignment;`)).code).toBe(0);
    const afterRevocation = await sql(url, bootstrapSql("Replacement", "replacement@example.com"));
    expect(afterRevocation.stderr).toContain("FIRST_ADMIN_ALREADY_EXISTS");
    const counts = await sql(url, "select (select count(*) from users),(select count(*) from admin_credentials),(select count(*) from system_authority_assignments),(select count(*) from instance_bootstrap);");
    expect(counts.stdout.trim()).toBe("1,1,1,1");
  });

  it("rolls back completely for each pre-existing evidence guard and missing taxonomy", async () => {
    const url = databaseUrl(databaseNames.rollback);
    const counts = "select (select count(*) from users),(select count(*) from admin_credentials),(select count(*) from system_authority_assignments),(select count(*) from instance_bootstrap),(select count(*) from audit_logs);";
    const baseline = await sql(url, counts);
    const fixtureUser = `insert into public.users(display_name,division_id,role_id,active)
      select 'Fixture',d.id,r.id,true from public.divisions d cross join public.roles r where d.code='IT' and r.code='ADMIN'
      returning id`;
    const cases = [
      `with fixture_user as (${fixtureUser}) insert into public.admin_credentials(user_id,email,password_algorithm,password_hash)
        select id,'fixture@example.com','scrypt','${hash}' from fixture_user;`,
      `with fixture_user as (${fixtureUser}) insert into public.system_authority_assignments(user_id,authority_code,revoked_at)
        select id,'SYSTEM_ADMIN',now() from fixture_user;`,
      `with fixture_user as (${fixtureUser}) insert into public.instance_bootstrap(singleton,first_admin_user_id,source)
        select 1,id,'fixture' from fixture_user;`,
      "update public.divisions set active=false where code='IT';",
      `alter table public.roles disable trigger protect_reserved_role_lifecycle;
       update public.roles set active=false where code='ADMIN';
       alter table public.roles enable trigger protect_reserved_role_lifecycle;`,
    ];
    for (const fixture of cases) {
      const attempt = await sql(url, `begin; ${fixture} ${bootstrapSql("Rollback Installer", "rollback@example.com")}`);
      expect(attempt.code).not.toBe(0);
      expect(attempt.stderr).toMatch(/FIRST_ADMIN_ALREADY_EXISTS|TAXONOMY_UNAVAILABLE/);
      const state = await sql(url, counts);
      expect(state.stdout).toBe(baseline.stdout);
    }
  });

  it("rolls back identity, credential, authority, and marker when the final audit write fails", async () => {
    const url = databaseUrl(databaseNames.rollback);
    const counts = "select (select count(*) from users),(select count(*) from admin_credentials),(select count(*) from system_authority_assignments),(select count(*) from instance_bootstrap),(select count(*) from audit_logs);";
    const baseline = await sql(url, counts);
    expect((await sql(url, `create function public.reject_bootstrap_audit() returns trigger language plpgsql set search_path='' as $$
      begin if new.action='FIRST_ADMIN_BOOTSTRAPPED' then raise exception 'FORCED_AUDIT_FAILURE'; end if; return new; end $$;
      create trigger reject_bootstrap_audit before insert on public.audit_logs for each row execute function public.reject_bootstrap_audit();`)).code).toBe(0);
    const attempt = await sql(url, bootstrapSql("Rollback Installer", "rollback@example.com"));
    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain("FORCED_AUDIT_FAILURE");
    expect((await sql(url, counts)).stdout).toBe(baseline.stdout);
    expect((await sql(url, "drop trigger reject_bootstrap_audit on public.audit_logs; drop function public.reject_bootstrap_audit();")).code).toBe(0);
  });

  it("serializes concurrent operators on the established advisory lock", async () => {
    const url = databaseUrl(databaseNames.concurrent);
    const [one, two] = await Promise.all([
      sql(url, bootstrapSql("Concurrent One", "one@example.com")),
      sql(url, bootstrapSql("Concurrent Two", "two@example.com")),
    ]);
    expect([one.code, two.code].filter((code) => code === 0)).toHaveLength(1);
    expect(one.stderr + two.stderr).toContain("FIRST_ADMIN_ALREADY_EXISTS");
    const state = await sql(url, "select (select count(*) from users),(select count(*) from admin_credentials),(select count(*) from system_authority_assignments),(select count(*) from instance_bootstrap),(select count(*) from audit_logs where action='FIRST_ADMIN_BOOTSTRAPPED');");
    expect(state.stdout.trim()).toBe("1,1,1,1,1");
  });

  it("retains exactly-once behavior with the advisory lock removed", async () => {
    const url = databaseUrl(databaseNames.structural);
    const definition = await sql(url, `select pg_get_functiondef('public.bootstrap_first_admin(text,text,text,text)'::regprocedure);`);
    expect(definition.code).toBe(0);
    const withoutLock = definition.stdout.replace(
      "perform pg_advisory_xact_lock(hashtextextended('gwens_system_admin_invariant', 0));",
      "-- advisory lock removed by structural-backstop integration test",
    ).replace(
      "  select count(*), min(id) into candidate_count, administrative_division_id",
      "  perform pg_sleep(1);\n\n  select count(*), min(id) into candidate_count, administrative_division_id",
    );
    expect(withoutLock).not.toContain("perform pg_advisory_xact_lock");
    expect(withoutLock).toContain("perform pg_sleep(1)");
    expect((await sql(url, withoutLock)).code).toBe(0);
    const [one, two] = await Promise.all([
      sql(url, bootstrapSql("Structural One", "structural-one@example.com")),
      sql(url, bootstrapSql("Structural Two", "structural-two@example.com")),
    ]);
    expect([one.code, two.code].filter((code) => code === 0)).toHaveLength(1);
    expect([one.code, two.code].filter((code) => code !== 0)).toHaveLength(1);
    const state = await sql(url, "select (select count(*) from users),(select count(*) from admin_credentials),(select count(*) from system_authority_assignments),(select count(*) from instance_bootstrap),(select count(*) from audit_logs where action='FIRST_ADMIN_BOOTSTRAPPED');");
    expect(state.stdout.trim()).toBe("1,1,1,1,1");
  });

  it("keeps the RPC service-only, both tables deny-all, and audit immutable", async () => {
    const url = databaseUrl(databaseNames.success);
    const privileges = await sql(url, `select
      has_function_privilege('anon','public.bootstrap_first_admin(text,text,text,text)','EXECUTE'),
      has_function_privilege('authenticated','public.bootstrap_first_admin(text,text,text,text)','EXECUTE'),
      has_function_privilege('service_role','public.bootstrap_first_admin(text,text,text,text)','EXECUTE'),
      (select bool_and(relrowsecurity) from pg_class where oid in ('public.admin_credentials'::regclass,'public.instance_bootstrap'::regclass)),
      (select count(*) from pg_policies where schemaname='public' and tablename in ('admin_credentials','instance_bootstrap'));`);
    expect(privileges.stdout.trim()).toBe("f,f,t,t,0");
    const mutation = await sql(url, "update public.audit_logs set source='forbidden' where action='FIRST_ADMIN_BOOTSTRAPPED';");
    expect(mutation.code).not.toBe(0);
    expect(mutation.stderr).toContain("audit_logs is append-only");
  });
});
