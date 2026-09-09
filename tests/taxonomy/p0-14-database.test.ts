import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const adminUrl = process.env.SOTOAYAM_TEST_POSTGRES_ADMIN_URL;
const psql = process.env.SOTOAYAM_TEST_PSQL ?? "psql";
const runDatabase = Boolean(adminUrl);
const prefix = `sotoayam_p014_${process.pid}_${Date.now()}`;
const databases = Object.fromEntries(
  ["fresh", "legacy", "safety", "compatibility", "concurrent"].map((kind) => [kind, `${prefix}_${kind}`]),
) as Record<"fresh" | "legacy" | "safety" | "compatibility" | "concurrent", string>;
const hash = "scrypt$N=32768,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
let legacyBefore = "";

function databaseUrl(name: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function sql(url: string, statement: string) {
  try {
    const { stdout, stderr } = await execute(psql, ["-d", url, "-v", "ON_ERROR_STOP=1", "-At", "-F", ",", "-c", statement], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: Number(failure.code ?? 1), stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
}

async function migrate(url: string, through?: string, after?: string): Promise<void> {
  const directory = path.resolve("supabase/migrations");
  const migrations = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()
    .filter((file) => (!through || file <= through) && (!after || file > after));
  for (const migration of migrations) {
    await execute(psql, ["-d", url, "-v", "ON_ERROR_STOP=1", "-q", "-f", path.join(directory, migration)], {
      maxBuffer: 4 * 1024 * 1024,
    });
  }
}

function provision(lineage: "FRESH" | "LEGACY", code: string, name: string, email = "installer@example.com"): string {
  return `select * from public.provision_first_installation(
    'Installer','${email}','scrypt','${hash}','${lineage}','${code}','${name}');`;
}

const operationalCounts = `select
  (select count(*) from public.divisions),
  (select count(*) from public.division_collaboration_rules),
  (select count(*) from public.users),
  (select count(*) from public.telegram_users),
  (select count(*) from public.tasks),
  (select count(*) from public.audit_logs);`;

describe.skipIf(!runDatabase)("P0-14 disposable PostgreSQL transition", () => {
  beforeAll(async () => {
    const roles = `do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;`;
    expect((await sql(adminUrl!, roles)).code).toBe(0);
    for (const database of Object.values(databases)) {
      expect((await sql(adminUrl!, `create database ${database}`)).code).toBe(0);
    }

    await Promise.all([
      migrate(databaseUrl(databases.fresh)),
      migrate(databaseUrl(databases.safety)),
      migrate(databaseUrl(databases.compatibility)),
      migrate(databaseUrl(databases.concurrent)),
      migrate(databaseUrl(databases.legacy), "202609090001_create_first_admin_bootstrap.sql"),
    ]);

    const legacyUrl = databaseUrl(databases.legacy);
    expect((await sql(legacyUrl, `select * from public.bootstrap_first_admin('Legacy Admin','legacy@example.com','scrypt','${hash}');`)).code).toBe(0);
    expect((await sql(legacyUrl, `with legacy as (
      insert into public.telegram_users (telegram_chat_id, name, division, role, active)
      values (987654321, 'Legacy Staff', 'IT', 'Staff', true) returning id
    ) insert into public.users (display_name, division_id, role_id, active, legacy_telegram_user_id)
      select 'Legacy Staff', divisions.id, roles.id, true, legacy.id
      from legacy cross join public.divisions divisions cross join public.roles roles
      where divisions.code='IT' and roles.code='STAFF';
      insert into public.tasks (title,status,priority,source,created_by_user_id,requesting_division_id,owner_division_id,task_category)
      select 'Historical affiliate task','OPEN','NORMAL','MANUAL',users.id,divisions.id,divisions.id,'AFFILIATE'
      from public.users users cross join public.divisions divisions
      where users.display_name='Legacy Admin' and divisions.code='CONTENT_CREATOR';`)).code).toBe(0);
    legacyBefore = (await sql(legacyUrl, operationalCounts)).stdout;
    await migrate(legacyUrl, undefined, "202609090001_create_first_admin_bootstrap.sql");

    expect((await sql(databaseUrl(databases.fresh), provision("FRESH", "OPERATIONS", "Operations"))).code).toBe(0);
  }, 120_000);

  afterAll(async () => {
    for (const database of Object.values(databases)) await sql(adminUrl!, `drop database if exists ${database} with (force)`);
  }, 30_000);

  it("T: migrates cleanly and provisions a customer-owned fresh installation", async () => {
    const state = await sql(databaseUrl(databases.fresh), `select
      (select count(*) from divisions),
      (select string_agg(code, ';' order by code) from divisions),
      (select bool_and(grants_system_authority and provisioning_source='SETUP') from divisions),
      (select count(*) from division_collaboration_rules),
      (select count(*) from users), (select count(*) from admin_credentials),
      (select count(*) from system_authority_assignments where authority_code='SYSTEM_ADMIN' and revoked_at is null),
      (select count(*) from instance_bootstrap),
      (select lineage || ':' || origin_seed_retired_count from installation_provenance),
      (select count(*) from task_categories),
      (select count(*) from audit_logs);`);
    expect(state.code).toBe(0);
    expect(state.stdout.trim()).toBe("1,OPERATIONS,t,0,1,1,1,1,FRESH:10,0,13");
  });

  it("A/B/C: keeps provenance explicit, append-only, deny-by-default, and service-role read-only", async () => {
    const url = databaseUrl(databases.fresh);
    const privileges = await sql(url, `select
      has_table_privilege('service_role','public.installation_provenance','SELECT'),
      has_table_privilege('service_role','public.installation_provenance','INSERT'),
      has_table_privilege('anon','public.installation_provenance','SELECT'),
      has_function_privilege('service_role','public.provision_first_installation(text,text,text,text,text,text,text)','EXECUTE'),
      has_function_privilege('anon','public.provision_first_installation(text,text,text,text,text,text,text)','EXECUTE'),
      (select relrowsecurity from pg_class where oid='public.installation_provenance'::regclass),
      (select count(*) from pg_policies where schemaname='public' and tablename='installation_provenance');`);
    expect(privileges.stdout.trim()).toBe("t,f,f,t,f,t,0");
    const mutation = await sql(url, "update public.installation_provenance set lineage='LEGACY';");
    expect(mutation.code).not.toBe(0);
    expect(mutation.stderr).toContain("append-only");
  });

  it("D/E/F: refuses evidence and code/name collisions without retiring any row", async () => {
    const url = databaseUrl(databases.safety);
    const before = await sql(url, operationalCounts);
    const evidence = await sql(url, `begin;
      insert into public.users (display_name,division_id,role_id,active)
      select 'Dormant User',divisions.id,roles.id,true from divisions cross join roles where divisions.code='IT' and roles.code='STAFF';
      ${provision("FRESH", "OPERATIONS", "Operations")}`);
    expect(evidence.code).not.toBe(0);
    expect(evidence.stderr).toContain("FRESH_INSTALL_EVIDENCE_VETO");
    expect((await sql(url, operationalCounts)).stdout).toBe(before.stdout);

    const collision = await sql(url, `begin; update public.divisions set name='Customer IT' where code='IT';
      ${provision("FRESH", "IT", "Customer IT")}`);
    expect(collision.code).not.toBe(0);
    expect(collision.stderr).toContain("FRESH_INSTALL_SEED_MISMATCH");
    expect((await sql(url, operationalCounts)).stdout).toBe(before.stdout);
  });

  it("rolls retirement, provenance, identity, credential, authority, and marker back on a late audit failure", async () => {
    const url = databaseUrl(databases.safety);
    const before = await sql(url, operationalCounts);
    expect((await sql(url, `create function public.reject_provenance_audit() returns trigger language plpgsql set search_path='' as $$
      begin if new.action='INSTALLATION_PROVENANCE_DECLARED' then raise exception 'FORCED_LATE_FAILURE'; end if; return new; end $$;
      create trigger reject_provenance_audit before insert on public.audit_logs
      for each row execute function public.reject_provenance_audit();`)).code).toBe(0);
    const attempt = await sql(url, provision("FRESH", "OPERATIONS", "Operations"));
    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain("FORCED_LATE_FAILURE");
    expect((await sql(url, operationalCounts)).stdout).toBe(before.stdout);
    expect((await sql(url, `select (select count(*) from installation_provenance),
      (select count(*) from admin_credentials),(select count(*) from instance_bootstrap);`)).stdout.trim()).toBe("0,0,0");
    expect((await sql(url, "drop trigger reject_provenance_audit on public.audit_logs; drop function public.reject_provenance_audit();")).code).toBe(0);
  });

  it("H/J: supports guarded capability handover and gives a newly named IT division no privilege", async () => {
    const url = databaseUrl(databases.fresh);
    const created = await sql(url, "select code,grants_system_authority,provisioning_source from public.create_customer_division('IT','Customer IT',1,'test');");
    expect(created.stdout.trim()).toBe("IT,f,CUSTOMER");
    expect((await sql(url, `grant select on public.divisions to service_role;
      grant update (grants_system_authority) on public.divisions to service_role;`)).code).toBe(0);
    const direct = await sql(url, "set role service_role; update public.divisions set grants_system_authority=true where code='IT';");
    expect(direct.code).not.toBe(0);
    expect(direct.stderr).toContain("owner SECURITY DEFINER path");
    expect((await sql(url, `revoke update (grants_system_authority) on public.divisions from service_role;
      revoke select on public.divisions from service_role;`)).code).toBe(0);

    expect((await sql(url, `select (public.set_division_system_authority((select id from divisions where code='IT'),true,1,'test')).code;
      select * from public.update_user_access(1,(select id from divisions where code='IT'),(select id from roles where code='ADMIN'),true,1,'test');
      select (public.set_division_system_authority((select id from divisions where code='OPERATIONS'),false,1,'test')).code;`)).code).toBe(0);
    const handover = await sql(url, "select code,grants_system_authority from divisions order by code;");
    expect(handover.stdout.trim().split(/\r?\n/)).toEqual(["IT,t", "OPERATIONS,f"]);
    const finalRemoval = await sql(url, "select public.update_customer_division((select id from divisions where code='IT'),null,false,1,'test');");
    expect(finalRemoval.code).not.toBe(0);
    expect(finalRemoval.stderr).toContain("DIVISION_AUTHORITY_REQUIRED");
    expect((await sql(url, "select code from public.delete_customer_division((select id from divisions where code='OPERATIONS'),1,'test');")).stdout.trim()).toBe("OPERATIONS");
  });

  it("K/L/M/N/O: preserves normalized assignment/display precedence and historical categories on legacy upgrade", async () => {
    const url = databaseUrl(databases.legacy);
    expect((await sql(url, operationalCounts)).stdout).toBe(legacyBefore);
    const transition = await sql(url, `update public.divisions set name='Technology Operations' where code='IT';
      select public.create_customer_division('FULFILLMENT','Fulfillment',1,'test');
      select * from public.update_user_access(
        (select id from users where display_name='Legacy Staff'),
        (select id from divisions where code='FULFILLMENT'),
        (select id from roles where code='STAFF'),true,1,'test');
      select telegram.division,telegram.role from telegram_users telegram where telegram_chat_id=987654321;
      select code,active from task_categories order by code;
      select task_category from tasks where title='Historical affiliate task';`);
    expect(transition.code).toBe(0);
    const lines = transition.stdout.trim().split(/\r?\n/);
    expect(lines).toContain("Fulfillment,Staff");
    expect(lines).toContain("AFFILIATE,t");
    expect(lines).toContain("AFFILIATE");

    const category = await sql(url, `select code from public.create_task_category('RETURNS','Returns',1,'test');
      select code,active from public.update_task_category((select id from task_categories where code='RETURNS'),null,false,1,'test');`);
    expect(category.stdout.trim().split(/\r?\n/)).toEqual(["RETURNS", "RETURNS,f"]);
    const usedDelete = await sql(url, "select public.delete_task_category((select id from task_categories where code='AFFILIATE'),1,'test');");
    expect(usedDelete.code).not.toBe(0);
    expect(usedDelete.stderr).toContain("TASK_CATEGORY_IN_USE");

    expect((await sql(url, "select code,name from public.rename_reserved_role((select id from roles where code='OWNER'),'Business Owner',1,'test');")).stdout.trim())
      .toBe("OWNER,Business Owner");
    for (const forbidden of [
      "update public.roles set code='CUSTOM_OWNER' where code='OWNER'",
      "update public.roles set active=false where code='OWNER'",
      "delete from public.roles where code='OWNER'",
    ]) {
      const attempt = await sql(url, forbidden);
      expect(attempt.code).not.toBe(0);
      expect(attempt.stderr).toContain("Reserved role");
    }
  });

  it("I/U: upgrades a legacy fixture without changing business-row counts and retains IT authorization", async () => {
    const url = databaseUrl(databases.legacy);
    const result = await sql(url, `select
      (select grants_system_authority from divisions where code='IT'),
      public.is_system_authority_candidate((select user_id from system_authority_assignments where authority_code='SYSTEM_ADMIN')),
      (select count(*) from installation_provenance),
      (select count(*) from task_categories where code='AFFILIATE');`);
    expect(result.stdout.trim()).toBe("t,t,0,1");
  });

  it("V: retains one four-argument bootstrap contract and rejects zero or ambiguous capability resolution", async () => {
    const url = databaseUrl(databases.compatibility);
    const signatures = await sql(url, `select proname,pronargs from pg_proc
      where oid in ('public.bootstrap_first_admin(text,text,text,text)'::regprocedure,
        'public.provision_first_installation(text,text,text,text,text,text,text)'::regprocedure)
      order by proname;`);
    expect(signatures.stdout.trim().split(/\r?\n/)).toEqual(["bootstrap_first_admin,4", "provision_first_installation,7"]);
    for (const mutation of [
      "update divisions set grants_system_authority=false where code='IT'",
      "update divisions set grants_system_authority=true where code='MANAGEMENT'",
    ]) {
      const attempt = await sql(url, `begin; ${mutation}; select * from public.bootstrap_first_admin('Old CLI','old-cli@example.com','scrypt','${hash}');`);
      expect(attempt.code).not.toBe(0);
      expect(attempt.stderr).toContain("TAXONOMY_UNAVAILABLE");
    }
    const oldCall = await sql(url, `select * from public.bootstrap_first_admin('Old CLI','old-cli@example.com','scrypt','${hash}');`);
    expect(oldCall.code).toBe(0);
    expect((await sql(url, `select divisions.code,(select count(*) from installation_provenance)
      from users join divisions on divisions.id=users.division_id;`)).stdout.trim()).toBe("IT,0");
  });

  it("serializes concurrent fresh provisioning to exactly one complete installation", async () => {
    const url = databaseUrl(databases.concurrent);
    const [one, two] = await Promise.all([
      sql(url, provision("FRESH", "OPERATIONS", "Operations", "one@example.com")),
      sql(url, provision("FRESH", "FULFILLMENT", "Fulfillment", "two@example.com")),
    ]);
    expect([one.code, two.code].filter((code) => code === 0)).toHaveLength(1);
    expect(one.stderr + two.stderr).toContain("FIRST_ADMIN_ALREADY_EXISTS");
    expect((await sql(url, `select (select count(*) from divisions),(select count(*) from users),
      (select count(*) from admin_credentials),(select count(*) from system_authority_assignments),
      (select count(*) from installation_provenance),(select count(*) from instance_bootstrap);`)).stdout.trim()).toBe("1,1,1,1,1,1");
  });
});
