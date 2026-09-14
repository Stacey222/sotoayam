import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashOpaqueToken, type AdminSessionAuthenticator } from "../../src/auth/admin-session.js";
import { hashPassword } from "../../src/auth/admin-password.js";
import { AppError } from "../../src/errors.js";
import type { AdminSessionRepository, AdminSessionRecord, AdminCredentialRecord } from "../../src/repositories/admin-session.repository.js";
import { SupabaseUserManagementRepository } from "../../src/repositories/user-management.repository.js";
import { adminAuthRoutes } from "../../src/routes/admin-auth.routes.js";
import { adminUserManagementRoutes } from "../../src/routes/admin-user-management.routes.js";
import { AdminAuthenticationService } from "../../src/services/admin-authentication.service.js";
import { UserManagementService } from "../../src/services/user-management.service.js";
import { startDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../../scripts/check-clean-migrations.js";

const fixtureHash = "scrypt$N=32768,r=8,p=1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const literal = (value: string | null | undefined) => value == null ? "null" : `'${value.replaceAll("'", "''")}'`;
const number = (rows: string[]) => Number(rows[0]);

let db: DisposablePostgresDatabase;
let bootstrapActorId = 0;

async function effectiveActorId(): Promise<number> {
  return number(await db.query(`select users.id from public.system_authority_assignments assignments
    join public.users users on users.id=assignments.user_id join public.divisions divisions on divisions.id=users.division_id
    where assignments.revoked_at is null and users.active and divisions.active and divisions.grants_system_authority
    order by users.id limit 1`));
}

async function adminRoleId(): Promise<number> {
  return number(await db.query("select id from public.roles where code='ADMIN'"));
}

async function standardDivisionId(): Promise<number> {
  await db.query(`insert into public.divisions (code,name,active,grants_system_authority,provisioning_source)
    values ('P209_STANDARD','P2-09 Standard',true,false,'CUSTOMER') on conflict (code) do nothing`);
  return number(await db.query("select id from public.divisions where code='P209_STANDARD'"));
}

async function createAdmin(actorId: number, email: string, name: string, grant = false, hash = fixtureHash): Promise<number> {
  const roleId = await adminRoleId();
  return number(await db.query(`select user_id from public.create_administrator_account(
    ${literal(name)},${literal(email)},(select division_id from public.users where id=${actorId}),${roleId},${grant},
    'database integration test','scrypt',${literal(hash)},${actorId})`));
}

function installErrorHandler(app: ReturnType<typeof Fastify>) {
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const value = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR", "Unexpected failure");
    return reply.status(value.statusCode).send({ success: false, error: { code: value.code, message: value.message } });
  });
}

class PostgresSessionRepository implements AdminSessionRepository {
  lastTokenHash = "";
  constructor(private readonly database: DisposablePostgresDatabase) {}

  async findCredentialByEmail(email: string): Promise<AdminCredentialRecord | null> {
    const rows = await this.database.query(`select credentials.user_id,credentials.email,users.display_name,users.active,
      credentials.password_algorithm,credentials.password_hash,credentials.password_change_required
      from public.admin_credentials credentials join public.users users on users.id=credentials.user_id
      where credentials.email=${literal(email)} limit 1`);
    if (!rows[0]) return null;
    const [userId, storedEmail, displayName, active, algorithm, passwordHash, required] = rows[0].split("|");
    return { userId: Number(userId), email: storedEmail!, displayName: displayName!, active: active === "t",
      passwordAlgorithm: algorithm as "scrypt", passwordHash: passwordHash!, passwordChangeRequired: required === "t" };
  }
  async findCredentialByUserId(userId: number): Promise<AdminCredentialRecord | null> {
    const rows = await this.database.query(`select email from public.admin_credentials where user_id=${userId}`);
    return rows[0] ? this.findCredentialByEmail(rows[0]) : null;
  }
  async evaluateLoginGate() { return { locked: false, retryAfterSeconds: 0 }; }
  async recordLoginFailure() { throw new Error("Unexpected login failure"); }
  async createSession(input: { userId: number; tokenHash: string; csrfTokenHash: string; absoluteTtlSeconds: number;
    clientIp: string | null; userAgentDigest: string | null }) {
    this.lastTokenHash = input.tokenHash;
    const row = (await this.database.query(`select session_id,issued_at,expires_at from public.create_admin_session(
      ${input.userId},${literal(input.tokenHash)},${literal(input.csrfTokenHash)},${input.absoluteTtlSeconds},
      ${input.clientIp ? `${literal(input.clientIp)}::inet` : "null"},${literal(input.userAgentDigest)})`))[0]!.split("|");
    return { sessionId: row[0]!, issuedAt: row[1]!, expiresAt: row[2]! };
  }
  async validateSession(tokenHash: string, idleTimeoutSeconds: number): Promise<AdminSessionRecord | null> {
    const rows = await this.database.query(`select session_id,user_id,email,display_name,expires_at,csrf_token_hash,password_change_required
      from public.validate_admin_session(${literal(tokenHash)},${idleTimeoutSeconds},60)`);
    if (!rows[0]) return null;
    const [sessionId, userId, email, displayName, expiresAt, csrfTokenHash, required] = rows[0].split("|");
    return { sessionId: sessionId!, userId: Number(userId), email: email!, displayName: displayName!, expiresAt: expiresAt!,
      csrfTokenHash: csrfTokenHash!, passwordChangeRequired: required === "t" };
  }
  async changePassword(userId: number, algorithm: "scrypt", hash: string, actorUserId: number, keepSessionId: string | null = null) {
    await this.database.query(`select public.change_admin_password(${userId},${literal(algorithm)},${literal(hash)},${actorUserId},
      ${keepSessionId ? `${literal(keepSessionId)}::uuid` : "null"})`);
  }
  async revokeSession() { return false; }
  async revokeSessionsForUser() { return 0; }
  async listSessions() { return []; }
}

describe.sequential("P2-09 disposable PostgreSQL behavioral proof", () => {
  beforeAll(async () => {
    db = await startDisposablePostgresDatabase("sotoayam-p209-db-");
    bootstrapActorId = number(await db.query(`select user_id from public.provision_first_installation(
      'P2-09 Bootstrap','p209-bootstrap@example.test','scrypt',${literal(fixtureHash)},'FRESH','OPERATIONS','Operations')`));
  }, 60_000);
  afterAll(async () => { await db?.close(); }, 30_000);

  it("U-16 serializes concurrent mutual revoke/deactivation so exactly one succeeds", async () => {
    const actorA = await effectiveActorId(); const roleId = await adminRoleId();
    const actorB = number(await db.query(`insert into public.users (display_name,division_id,role_id,active)
      select 'Concurrent Admin B',division_id,${roleId},true from public.users where id=${actorA} returning id`));
    await db.query(`select id from public.assign_system_admin(${actorB},'concurrency handover',${actorA})`);
    const results = await Promise.all([
      db.attempt(`select id from public.revoke_system_admin(${actorB},'concurrent revoke',${actorA})`),
      db.attempt(`select id from public.update_managed_user_access(${actorA},
        (select division_id from public.users where id=${actorA}),${roleId},false,${actorB},'database_integration',false,null)`),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(number(await db.query("select public.count_effective_system_admins()"))).toBe(1);
  });

  it("U-08 executes the unique index and maps a normalized collision to HTTP 409 EMAIL_ALREADY_IN_USE", async () => {
    const actorId = await effectiveActorId();
    await createAdmin(actorId, "duplicate@example.test", "Duplicate One");
    let observedConstraint = false;
    const client = { rpc: async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("create_administrator_account");
      const attempt = await db.attempt(`select user_id from public.create_administrator_account(
        ${literal(String(args.p_display_name))},${literal(String(args.p_email))},${args.p_division_id},${args.p_role_id},
        ${args.p_grant_system_admin},${literal(String(args.p_reason))},${literal(String(args.p_password_algorithm))},
        ${literal(String(args.p_password_hash))},${args.p_actor_user_id})`);
      if (!attempt.ok) {
        observedConstraint = /admin_credentials_email_uidx|duplicate key/i.test(attempt.error);
        return { data: null, error: { code: observedConstraint ? "23505" : "XX000", message: attempt.error } };
      }
      return { data: attempt.rows.map((user_id) => ({ user_id })), error: null };
    } };
    const repository = new SupabaseUserManagementRepository(client as never);
    const service = new UserManagementService(repository, {} as never, {} as never);
    const app = Fastify(); installErrorHandler(app);
    await app.register(adminUserManagementRoutes, { prefix: "/api/admin/users", service,
      sessionAuthenticator: { authenticate: async () => ({ kind: "session", adminUserId: actorId, sessionId: "db-session",
        email: "actor@example.test", displayName: "Actor", expiresAt: "2099-01-01T00:00:00Z" }), verifyCsrf: () => true },
      actorResolver: { resolveTrustedActor: vi.fn(), resolveActor: async () => ({ id: actorId, displayName: "Actor", active: true,
        divisionId: 1, divisionCode: "OPERATIONS", divisionGrantsSystemAuthority: true, roleId: 1, roleCode: "ADMIN", permissions: new Set() }) } });
    const response = await app.inject({ method: "POST", url: "/api/admin/users", payload: { display_name: "Duplicate Two",
      email: "  DUPLICATE@EXAMPLE.TEST  ", division_id: number(await db.query(`select division_id from public.users where id=${actorId}`)),
      role_id: await adminRoleId(), grant_system_admin: false, reason: "duplicate database proof" } });
    expect(observedConstraint).toBe(true); expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "EMAIL_ALREADY_IN_USE" } });
    expect(number(await db.query("select count(*) from public.admin_credentials where email='duplicate@example.test'"))).toBe(1);
    await app.close();
  }, 15_000);

  it("U-09 creates user/credential/authority/audit atomically and rolls back a forced failure", async () => {
    const actorId = await effectiveActorId(); const createdId = await createAdmin(actorId, "atomic-success@example.test", "Atomic Success", true);
    expect((await db.query(`select (select count(*) from public.users where id=${createdId}),
      (select count(*) from public.admin_credentials where user_id=${createdId}),
      (select count(*) from public.system_authority_assignments where user_id=${createdId} and revoked_at is null)`))[0]).toBe("1|1|1");
    expect(number(await db.query(`select count(*) from public.audit_logs logs where logs.actor_type='USER' and logs.actor_user_id=${actorId}
      and (logs.action='ADMIN_USER_CREATED' and logs.object_id=${literal(String(createdId))}
        or logs.action='SYSTEM_ADMIN_GRANTED' and logs.object_id=(select id::text from public.system_authority_assignments where user_id=${createdId} and revoked_at is null))`))).toBe(2);
    const stateBefore = (await db.query(`select (select count(*) from public.users),
      (select count(*) from public.admin_credentials),(select count(*) from public.system_authority_assignments),
      (select count(*) from public.audit_logs)`))[0];
    const standardDivision = await standardDivisionId();
    const failed = await db.attempt(`select user_id from public.create_administrator_account('Atomic Failure',
      'atomic-failure@example.test',${standardDivision},${await adminRoleId()},true,'forced failure','scrypt',${literal(fixtureHash)},${actorId})`);
    expect(failed.ok).toBe(false);
    expect(number(await db.query("select count(*) from public.users where display_name='Atomic Failure'"))).toBe(0);
    expect(number(await db.query("select count(*) from public.admin_credentials where email='atomic-failure@example.test'"))).toBe(0);
    expect((await db.query(`select (select count(*) from public.users),
      (select count(*) from public.admin_credentials),(select count(*) from public.system_authority_assignments),
      (select count(*) from public.audit_logs)`))[0]).toBe(stateBefore);
    await db.query(`select id from public.revoke_system_admin(${createdId},'fixture cleanup',${actorId})`);
  });

  it("U-11/U-17 grants login without Telegram identity and atomically revokes its session on deactivation", async () => {
    const actorId = await effectiveActorId(); const roleId = await adminRoleId(); const standardDivision = await standardDivisionId();
    const targetId = number(await db.query(`insert into public.users (display_name,division_id,role_id,active)
      values ('Operational Login',${standardDivision},${roleId},true) returning id`));
    await db.query(`select public.grant_admin_login(${targetId},'operational-login@example.test','grant login','scrypt',${literal(fixtureHash)},${actorId})`);
    expect((await db.query(`select (select count(*) from public.admin_credentials where user_id=${targetId}),
      (select count(*) from public.telegram_users where id=(select legacy_telegram_user_id from public.users where id=${targetId})),
      (select count(*) from public.user_channels where user_id=${targetId})`))[0]).toBe("1|0|0");
    await db.query(`insert into public.admin_sessions (user_id,token_hash,csrf_token_hash,expires_at)
      values (${targetId},repeat('c',64),repeat('d',64),now()+interval '1 hour')`);
    expect(await db.query(`select session_id from public.validate_admin_session(repeat('c',64),3600,60)`)).toHaveLength(1);
    await db.query(`select id from public.update_managed_user_access(${targetId},${standardDivision},
      ${roleId},false,${actorId},'database_integration',false,null)`);
    expect((await db.query(`select revoked_reason,count(*) from public.admin_sessions where user_id=${targetId} group by revoked_reason`))[0]).toBe("REVOKED_BY_ADMIN|1");
    expect(await db.query(`select session_id from public.validate_admin_session(repeat('c',64),3600,60)`)).toEqual([]);
  });

  it("U-12 authenticates a temporary password, blocks normal admin access, then clears the gate through password change", async () => {
    const actorId = await effectiveActorId(); const temporaryPassword = "P2-09-Temporary-Password-438!";
    const targetId = await createAdmin(actorId, "temporary-login@example.test", "Temporary Login", true,
      await hashPassword(temporaryPassword));
    const repository = new PostgresSessionRepository(db); const authentication = new AdminAuthenticationService(repository, 43_200);
    const login = await authentication.login({ email: "temporary-login@example.test", password: temporaryPassword, clientIp: "127.0.0.1" });
    expect(login.principal.passwordChangeRequired).toBe(true);
    const authenticator: AdminSessionAuthenticator = { authenticate: async () => {
      const session = await repository.validateSession(repository.lastTokenHash, 3_600);
      return session ? { kind: "session", adminUserId: session.userId, sessionId: session.sessionId,
        email: session.email, displayName: session.displayName, expiresAt: session.expiresAt,
        passwordChangeRequired: session.passwordChangeRequired } : null;
    }, verifyCsrf: () => true };
    const app = Fastify(); installErrorHandler(app);
    await app.register(adminAuthRoutes, { prefix: "/auth", service: authentication, authenticator, cookieSecure: false });
    await app.register(adminUserManagementRoutes, { prefix: "/users", sessionAuthenticator: authenticator,
      adminApiKeyFallbackEnabled: false, service: { listPage: vi.fn(async () => ({ data: [], nextCursor: null })) } as never,
      actorResolver: { resolveTrustedActor: vi.fn(), resolveActor: async () => {
        if (number(await db.query(`select public.is_effective_system_admin(${targetId})::int`)) !== 1) {
          throw new AppError(403, "ADMIN_AUTHORITY_REQUIRED", "Authority required");
        }
        return { id: targetId, displayName: "Temporary Login", active: true, divisionId: 1, divisionCode: "OPERATIONS",
          divisionGrantsSystemAuthority: true, roleId: await adminRoleId(), roleCode: "ADMIN", permissions: new Set<string>() };
      } } });
    expect((await app.inject({ url: "/users" })).json()).toMatchObject({ error: { code: "PASSWORD_CHANGE_REQUIRED" } });
    const changed = await app.inject({ method: "POST", url: "/auth/password", payload: { current_password: temporaryPassword,
      new_password: "P2-09-Replacement-Password-973!" } });
    expect(changed.statusCode).toBe(204);
    expect(number(await db.query(`select password_change_required::int from public.admin_credentials where user_id=${targetId}`))).toBe(0);
    expect((await app.inject({ url: "/users" })).statusCode).toBe(200);
    await app.close();
    await db.query(`select id from public.revoke_system_admin(${targetId},'temporary test cleanup',${actorId})`);
  }, 20_000);

  it("U-13 records the real USER actor for executed profile/access mutations", async () => {
    const actorId = await effectiveActorId(); const targetId = await createAdmin(actorId, "audit-target@example.test", "Audit Target");
    const standardDivision = await standardDivisionId();
    await db.query(`select public.update_admin_user_profile(${targetId},'Audit Target Updated',${actorId})`);
    await db.query(`select id from public.update_managed_user_access(${targetId},
      ${standardDivision},${await adminRoleId()},true,${actorId},'admin_user_management_api',false,null)`);
    const rows = await db.query(`select count(*) from public.audit_logs where object_id=${literal(String(targetId))}
      and action in ('USER_PROFILE_UPDATED','USER_DIVISION_CHANGED') and actor_type='USER' and actor_user_id=${actorId}
      and source='admin_user_management_api'`);
    expect(number(rows)).toBe(2);
    expect(number(await db.query(`select count(*) from public.audit_logs where object_id=${literal(String(targetId))}
      and (actor_type='SYSTEM' or source='admin_api_shared_key')`))).toBe(0);
  });

  it("U-15/U-16 preserves an effective admin across every sequential mixed reduction path", async () => {
    const checks = await db.query(`begin; do $verify$
      declare a bigint; b bigint; authority_division bigint; standard_division bigint; role_id bigint;
      begin
        select id into a from public.users where id=(select users.id from public.system_authority_assignments assignments
          join public.users users on users.id=assignments.user_id join public.divisions divisions on divisions.id=users.division_id
          where assignments.revoked_at is null and users.active and divisions.active and divisions.grants_system_authority order by users.id limit 1);
        select division_id into authority_division from public.users where id=a;
        select id into standard_division from public.divisions where code='P209_STANDARD';
        select id into role_id from public.roles where code='ADMIN';

        insert into public.users (display_name,division_id,role_id,active) values ('Mixed B',authority_division,role_id,true) returning id into b;
        perform public.assign_system_admin(b,'mixed sequence',a);
        perform public.update_managed_user_access(a,authority_division,role_id,false,b,'database_integration',false,null);
        begin perform public.update_managed_user_access(b,authority_division,role_id,false,b,'database_integration',false,null);
          raise exception 'deactivate A then B was allowed'; exception when insufficient_privilege then null; end;
        if public.count_effective_system_admins() < 1 then raise exception 'deactivate A then B lost all admins'; end if;
      end $verify$; rollback;`);
    expect(checks).toContain("ROLLBACK");

    for (const scenario of ["deactivate_then_revoke", "move", "capability", "division_deactivate"]) {
      const result = await db.attempt(`begin; do $verify$
        declare a bigint; b bigint; d bigint; standard bigint; r bigint;
        begin
          select users.id,users.division_id into a,d from public.system_authority_assignments assignments
          join public.users users on users.id=assignments.user_id join public.divisions divisions on divisions.id=users.division_id
          where assignments.revoked_at is null and users.active and divisions.active and divisions.grants_system_authority order by users.id limit 1;
          select id into standard from public.divisions where code='P209_STANDARD'; select id into r from public.roles where code='ADMIN';
          insert into public.users(display_name,division_id,role_id,active) values('Scenario B',d,r,true) returning id into b;
          perform public.assign_system_admin(b,'scenario fixture',a);
          if ${literal(scenario)}='deactivate_then_revoke' then
            perform public.update_managed_user_access(b,d,r,false,a,'database_integration',false,null);
            begin perform public.revoke_system_admin(a,'must retain one',a); exception when sqlstate 'P0001' then null; end;
          elsif ${literal(scenario)}='move' then
            perform public.update_managed_user_access(b,d,r,false,a,'database_integration',false,null);
            begin perform public.update_managed_user_access(a,standard,r,true,a,'database_integration',true,'confirmed self demotion'); exception when sqlstate 'P0001' then null; end;
          elsif ${literal(scenario)}='capability' then
            begin perform public.set_division_system_authority(d,false,a,'database_integration'); exception when sqlstate 'P0001' then null; end;
          else
            begin perform public.update_customer_division(d,null,false,a,'database_integration'); exception when sqlstate 'P0001' then null; end;
          end if;
          if public.count_effective_system_admins() < 1 then raise exception 'scenario lost all effective admins'; end if;
        end $verify$; rollback;`);
      expect(result.ok, `${scenario}: ${result.error}`).toBe(true);
    }
  });
});
