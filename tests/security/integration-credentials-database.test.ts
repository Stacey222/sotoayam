import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveIntegrationCredentialActor } from "../../src/cli/integration-credential.js";

const execute = promisify(execFile);
const adminUrl = process.env.SOTOAYAM_TEST_POSTGRES_ADMIN_URL;
const psql = process.env.SOTOAYAM_TEST_PSQL ?? "psql";
const runDatabase = Boolean(adminUrl);
const databaseName = `sotoayam_p104_${process.pid}_${Date.now()}`;
const fixtureHash = "scrypt$N=32768,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
let actorId = 0;
let sequence = 0;

function databaseUrl(): string { const url = new URL(adminUrl!); url.pathname = `/${databaseName}`; return url.toString(); }
async function sql(statement: string, url = databaseUrl()) {
  try {
    const { stdout, stderr } = await execute(psql, ["-d", url, "-v", "ON_ERROR_STOP=1", "-At", "-F", ",", "-c", statement],
      { maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout: stdout.trim(), stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: Number(failure.code ?? 1), stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function selector(): string { sequence += 1; return String(sequence).padStart(16, "0"); }
async function integration(): Promise<number> {
  sequence += 1; const code = `P104_${sequence}`;
  const created = await sql(`select id from public.create_task_source_integration('${code}','P1-04 ${sequence}','AUTOMATION',
    (select division_id from public.users where id=${actorId}),${actorId})`);
  expect(created.code).toBe(0); const id = Number(created.stdout);
  expect((await sql(`select id from public.set_task_source_integration_active(${id},true,${actorId})`)).code).toBe(0);
  expect((await sql(`select id from public.grant_integration_capability(${id},'TASK_CREATE',${actorId})`)).code).toBe(0);
  return id;
}
async function credential(integrationId: number, secret = `secret-${sequence}`) {
  const handle = selector(); const hash = digest(secret);
  const result = await sql(`select id from public.create_integration_credential(${integrationId},'${handle}','${hash}',
    'database test',null,null,${actorId})`);
  expect(result.code).toBe(0); return { id: Number(result.stdout), selector: handle, hash, secret };
}
async function authenticate(handle: string, hash: string): Promise<string> {
  return (await sql(`select status from public.authenticate_integration_credential('${handle}','${hash}','TASK_CREATE')`)).stdout;
}

describe.skipIf(!runDatabase)("P1-04 disposable PostgreSQL credential invariants", () => {
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
      'P104 Admin','p104@local.invalid','scrypt','${fixtureHash}','FRESH','OPERATIONS','Operations')`);
    expect(provisioned.code).toBe(0); actorId = Number(provisioned.stdout);
  }, 60_000);
  afterAll(async () => { await sql(`drop database if exists ${databaseName} with (force)`, adminUrl!); }, 15_000);

  it("P4-08 stores only the SHA-256 digest and never the raw secret", async () => {
    const integrationId = await integration(); const raw = `raw-${Date.now()}-${sequence}`;
    const created = await credential(integrationId, raw);
    const stored = await sql(`select secret_hash,(row_to_json(credentials)::text like '%${raw}%')
      from public.integration_credentials credentials where id=${created.id}`);
    expect(stored.stdout).toBe(`${digest(raw)},f`);
  });

  it("P4-09 denies direct service-role reads and exposes no hash through RPC return types", async () => {
    expect((await sql("set role service_role; select * from public.integration_credentials limit 1")).code).not.toBe(0);
    const schema = await sql(`select count(*) from information_schema.parameters where specific_schema='public'
      and specific_name like 'list_integration_credentials_%' and parameter_name='secret_hash'`);
    expect(schema.stdout).toBe("0");
  });

  it("P4-10 revokes one integration credential without affecting another", async () => {
    const a = await credential(await integration()); const b = await credential(await integration());
    expect((await sql(`select id from public.revoke_integration_credential(${a.id},'COMPROMISED',null,${actorId})`)).code).toBe(0);
    expect(await authenticate(a.selector, a.hash)).toBe("REVOKED"); expect(await authenticate(b.selector, b.hash)).toBe("OK");
  });

  it("P4-11 supports two-credential overlap and retirement", async () => {
    const integrationId = await integration(); const a = await credential(integrationId); const b = await credential(integrationId);
    expect(await authenticate(a.selector, a.hash)).toBe("OK"); expect(await authenticate(b.selector, b.hash)).toBe("OK");
    await sql(`select id from public.revoke_integration_credential(${a.id},'ROTATED',null,${actorId})`);
    expect(await authenticate(a.selector, a.hash)).toBe("REVOKED"); expect(await authenticate(b.selector, b.hash)).toBe("OK");
  });

  it("P4-12 enforces the two-active maximum under concurrent creation", async () => {
    const integrationId = await integration(); await credential(integrationId);
    const a = selector(); const b = selector();
    const attempts = await Promise.all([a, b].map((handle) => sql(`select id from public.create_integration_credential(
      ${integrationId},'${handle}','${digest(handle)}','race',null,null,${actorId})`)));
    expect(attempts.filter((result) => result.code === 0)).toHaveLength(1);
    expect((await sql(`select count(*) from public.integration_credentials where integration_id=${integrationId}
      and revoked_at is null and (expires_at is null or expires_at>now())`)).stdout).toBe("2");
  });

  it("P4-13 applies immediate revocation on the next authentication", async () => {
    const created = await credential(await integration()); expect(await authenticate(created.selector, created.hash)).toBe("OK");
    await sql(`select id from public.revoke_integration_credential(${created.id},'COMPROMISED',null,${actorId})`);
    expect(await authenticate(created.selector, created.hash)).toBe("REVOKED");
  });

  it("P4-14 honors grace expiry and lets immediate revocation override it", async () => {
    const created = await credential(await integration());
    await sql(`select id from public.revoke_integration_credential(${created.id},'ROTATED',60,${actorId})`);
    expect(await authenticate(created.selector, created.hash)).toBe("OK");
    await sql(`update public.integration_credentials set expires_at=now()-interval '1 second' where id=${created.id}`);
    expect(await authenticate(created.selector, created.hash)).toBe("EXPIRED");
    await sql(`select id from public.revoke_integration_credential(${created.id},'COMPROMISED',null,${actorId})`);
    expect(await authenticate(created.selector, created.hash)).toBe("REVOKED");
  });

  it("rejects grace for an already-expired credential without reactivating it", async () => {
    const created = await credential(await integration());
    await sql(`update public.integration_credentials set expires_at=now()-interval '1 second' where id=${created.id}`);
    const grace = await sql(`select id from public.revoke_integration_credential(${created.id},'ROTATED',60,${actorId})`);
    expect(grace.code).not.toBe(0);
    expect(grace.stderr).toContain("Cannot apply grace to an expired integration credential");
    expect(await authenticate(created.selector, created.hash)).toBe("EXPIRED");
  });

  it("does not increase the active credential count when grace is requested for an expired credential", async () => {
    const integrationId = await integration(); const created = await credential(integrationId);
    await sql(`update public.integration_credentials set expires_at=now()-interval '1 second' where id=${created.id}`);
    const activeCount = () => sql(`select count(*) from public.integration_credentials where integration_id=${integrationId}
      and revoked_at is null and (expires_at is null or expires_at>now())`);
    expect((await activeCount()).stdout).toBe("0");
    expect((await sql(`select id from public.revoke_integration_credential(${created.id},'ROTATED',60,${actorId})`)).code).not.toBe(0);
    expect((await activeCount()).stdout).toBe("0");
  });

  it("never extends an existing future expiry with a later grace request", async () => {
    const created = await credential(await integration());
    await sql(`update public.integration_credentials set expires_at=now()+interval '5 minutes' where id=${created.id}`);
    const before = (await sql(`select expires_at from public.integration_credentials where id=${created.id}`)).stdout;
    expect((await sql(`select id from public.revoke_integration_credential(${created.id},'ROTATED',600,${actorId})`)).code).toBe(0);
    expect((await sql(`select expires_at from public.integration_credentials where id=${created.id}`)).stdout).toBe(before);
  });

  it("lets immediate revocation override an existing grace deadline", async () => {
    const created = await credential(await integration());
    expect((await sql(`select id from public.revoke_integration_credential(${created.id},'ROTATED',300,${actorId})`)).code).toBe(0);
    expect(await authenticate(created.selector, created.hash)).toBe("OK");
    expect((await sql(`select id from public.revoke_integration_credential(${created.id},'COMPROMISED',null,${actorId})`)).code).toBe(0);
    expect(await authenticate(created.selector, created.hash)).toBe("REVOKED");
  });

  it("preserves the maximum-two-active invariant across create and every revoke or grace path", async () => {
    const integrationId = await integration(); const first = await credential(integrationId); const second = await credential(integrationId);
    const activeCount = () => sql(`select count(*) from public.integration_credentials where integration_id=${integrationId}
      and revoked_at is null and (expires_at is null or expires_at>now())`);
    expect((await activeCount()).stdout).toBe("2");
    expect((await sql(`select id from public.revoke_integration_credential(${first.id},'ROTATED',300,${actorId})`)).code).toBe(0);
    expect((await activeCount()).stdout).toBe("2");
    expect((await sql(`select id from public.revoke_integration_credential(${first.id},'ROTATED',60,${actorId})`)).code).toBe(0);
    expect((await activeCount()).stdout).toBe("2");
    expect((await sql(`select id from public.revoke_integration_credential(${second.id},'ROTATED',null,${actorId})`)).code).toBe(0);
    expect((await activeCount()).stdout).toBe("1");
    const replacement = await credential(integrationId);
    expect((await activeCount()).stdout).toBe("2");
    expect((await sql(`select id from public.revoke_integration_credential(${second.id},'COMPROMISED',60,${actorId})`)).code).toBe(0);
    expect((await activeCount()).stdout).toBe("2");
    expect(await authenticate(replacement.selector, replacement.hash)).toBe("OK");
  });

  it("P4-15 sets last_used_at on first use and throttles it for sixty seconds", async () => {
    const created = await credential(await integration()); expect(await authenticate(created.selector, created.hash)).toBe("OK");
    const first = (await sql(`select last_used_at from public.integration_credentials where id=${created.id}`)).stdout;
    expect(await authenticate(created.selector, created.hash)).toBe("OK");
    expect((await sql(`select last_used_at from public.integration_credentials where id=${created.id}`)).stdout).toBe(first);
  });

  it("P4-16 rejects inactive integrations and bulk-revokes every credential", async () => {
    const integrationId = await integration(); const a = await credential(integrationId); const b = await credential(integrationId);
    await sql(`select id from public.set_task_source_integration_active(${integrationId},false,${actorId})`);
    expect(await authenticate(a.selector, a.hash)).toBe("INTEGRATION_INACTIVE");
    expect((await sql(`select public.revoke_integration_credentials_for_integration(${integrationId},'INTEGRATION_DISABLED',${actorId})`)).stdout).toBe("2");
    expect(await authenticate(a.selector, a.hash)).toBe("REVOKED"); expect(await authenticate(b.selector, b.hash)).toBe("REVOKED");
  });

  it("P4-17 writes user lifecycle audits containing selectors but no raw secret or digest", async () => {
    const raw = `audit-${Date.now()}-${sequence}`; const created = await credential(await integration(), raw);
    await sql(`select id from public.revoke_integration_credential(${created.id},'DECOMMISSIONED',null,${actorId})`);
    const audit = await sql(`select count(*),bool_and(actor_type='USER'),bool_and(after_state::text like '%${created.selector}%'),
      bool_and(after_state::text not like '%${raw}%' and after_state::text not like '%${created.hash}%')
      from public.audit_logs where object_type='INTEGRATION_CREDENTIAL' and object_id='${created.id}'`);
    expect(audit.stdout).toBe("2,t,t,t");
  });

  it("P4-18 executes a dummy digest comparison on unknown selectors", async () => {
    const definition = await sql(`select pg_get_functiondef('public.authenticate_integration_credential(text,text,text)'::regprocedure)`);
    expect(definition.stdout).toContain("select p_secret_hash = repeat('0', 64) into dummy_matches");
    expect(await authenticate("zzzzzzzzzzzzzzzz", digest("missing"))).toBe("UNKNOWN");
  });

  it("resolves the explicitly selected actor when two active SYSTEM_ADMIN users exist", async () => {
    const secondEmail = "p104-second@local.invalid";
    const created = await sql(`with created as (insert into public.users (display_name,division_id,role_id,active)
      select 'P1-04 Second Admin',users.division_id,users.role_id,true from public.users where users.id=${actorId}
      returning id) select id from created`);
    expect(created.code).toBe(0); const secondActorId = Number(created.stdout);
    const credentialInsert = await sql(`insert into public.admin_credentials (user_id,email,password_algorithm,password_hash)
      values (${secondActorId},'${secondEmail}','scrypt','${fixtureHash}')`);
    expect(credentialInsert.code, credentialInsert.stderr).toBe(0);
    expect((await sql(`select id from public.assign_system_admin(${secondActorId},'P1-04 actor resolution test',${actorId})`)).code).toBe(0);

    const resolved = await resolveIntegrationCredentialActor(secondEmail, {
      findCredentialByEmail: async (email) => {
        const row = await sql(`select credentials.user_id,users.active from public.admin_credentials credentials
          join public.users users on users.id=credentials.user_id where lower(credentials.email)=lower('${email}')`);
        if (!row.stdout) return null;
        const [userId, active] = row.stdout.split(",");
        return { userId: Number(userId), active: active === "t" };
      },
    }, {
      findById: async (id) => {
        const row = await sql(`select users.id,users.active,divisions.grants_system_authority from public.users users
          join public.divisions divisions on divisions.id=users.division_id where users.id=${id}`);
        if (!row.stdout) return null;
        const [userId, active, grants] = row.stdout.split(",");
        return { id: Number(userId), active: active === "t", divisionGrantsSystemAuthority: grants === "t" };
      },
      hasActiveSystemAdminAuthority: async (id) => (await sql(`select exists(select 1
        from public.system_authority_assignments where user_id=${id} and authority_code='SYSTEM_ADMIN' and revoked_at is null)`)).stdout === "t",
    });

    expect(resolved).toEqual({ id: secondActorId });
    expect(secondActorId).not.toBe(actorId);
    expect((await sql(`select count(*) from public.system_authority_assignments
      where authority_code='SYSTEM_ADMIN' and revoked_at is null`)).stdout).toBe("2");
  });
});
