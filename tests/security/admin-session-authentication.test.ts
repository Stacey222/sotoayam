import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyRequest } from "fastify";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defineAdminRoutes, resolveAdminPrincipal, type AdminPrincipal } from "../../src/auth/admin-authorization.js";
import { DatabaseAdminSessionAuthenticator, generateOpaqueToken, hashOpaqueToken,
  type SessionPrincipal } from "../../src/auth/admin-session.js";
import { hashPassword } from "../../src/auth/admin-password.js";
import { AppError } from "../../src/errors.js";
import type { AdminCredentialRecord, AdminSessionRepository, AdminSessionSummary,
  LoginFailureReason } from "../../src/repositories/admin-session.repository.js";
import { adminAuthRoutes } from "../../src/routes/admin-auth.routes.js";
import { AdminAuthenticationService } from "../../src/services/admin-authentication.service.js";
import { TrustedTaskActorService } from "../../src/services/task-actor.service.js";

const EMAIL = "admin@example.test";
const PASSWORD = "Correct-Horse-47!";
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
let encodedPassword = "";

beforeAll(async () => { encodedPassword = await hashPassword(PASSWORD); });

function credential(active = true): AdminCredentialRecord {
  return { userId: 7, email: EMAIL, displayName: "Primary Admin", active,
    passwordAlgorithm: "scrypt", passwordHash: encodedPassword };
}

class FakeSessionRepository implements AdminSessionRepository {
  credential: AdminCredentialRecord | null = credential();
  gate = { locked: false, retryAfterSeconds: 0 };
  failures: LoginFailureReason[] = [];
  createInputs: Parameters<AdminSessionRepository["createSession"]>[0][] = [];
  revoked: Array<{ sessionId: string; reason: string; actorUserId: number }> = [];
  changed: Parameters<AdminSessionRepository["changePassword"]> = [] as never;
  summaries: AdminSessionSummary[] = [];
  validated: Awaited<ReturnType<AdminSessionRepository["validateSession"]>> = null;

  async findCredentialByEmail(email: string) { return this.credential?.email === email ? this.credential : null; }
  async findCredentialByUserId(userId: number) { return this.credential?.userId === userId ? this.credential : null; }
  async evaluateLoginGate() { return this.gate; }
  async recordLoginFailure(_userId: number | null, _clientIp: string | null, reason: LoginFailureReason) { this.failures.push(reason); }
  async createSession(input: Parameters<AdminSessionRepository["createSession"]>[0]) {
    this.createInputs.push(input);
    return { sessionId: SESSION_ID, issuedAt: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-09T12:00:00.000Z" };
  }
  async validateSession() { return this.validated; }
  async revokeSession(sessionId: string, reason: "LOGOUT" | "REVOKED_BY_ADMIN", actorUserId: number) {
    this.revoked.push({ sessionId, reason, actorUserId }); return true;
  }
  async revokeSessionsForUser() { return 0; }
  async changePassword(...input: Parameters<AdminSessionRepository["changePassword"]>) { this.changed = input; }
  async listSessions() { return this.summaries; }
}

function principal(): SessionPrincipal {
  return { kind: "session", adminUserId: 7, sessionId: SESSION_ID, email: EMAIL,
    displayName: "Primary Admin", expiresAt: "2026-09-09T12:00:00.000Z" };
}

async function authApp(repository = new FakeSessionRepository(), secure = true) {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  app.setErrorHandler((error, _request, reply) => {
    const appError = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred");
    return reply.status(appError.statusCode).send({ success: false,
      error: { code: appError.code, message: appError.message } });
  });
  const authenticator = new DatabaseAdminSessionAuthenticator(repository, secure, 3_600);
  const service = new AdminAuthenticationService(repository, 43_200);
  await app.register(adminAuthRoutes, { service, authenticator, cookieSecure: secure, prefix: "/api/admin/auth" });
  return { app, repository, authenticator, service };
}

describe("P1-01 administrator sessions", () => {
  it("generates high-entropy opaque tokens and stores only SHA-256 hashes", async () => {
    const first = generateOpaqueToken();
    const second = generateOpaqueToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(hashOpaqueToken(first)).toMatch(/^[0-9a-f]{64}$/);
    const repository = new FakeSessionRepository();
    const result = await new AdminAuthenticationService(repository, 43_200).login({
      email: EMAIL, password: PASSWORD, clientIp: "127.0.0.1", userAgent: "test",
    });
    expect(repository.createInputs).toHaveLength(1);
    expect(repository.createInputs[0]!.tokenHash).toBe(hashOpaqueToken(result.sessionToken));
    expect(JSON.stringify(repository.createInputs[0])).not.toContain(result.sessionToken);
    expect(JSON.stringify(repository.createInputs[0])).not.toContain(result.csrfToken);
  });

  it("logs in and sets exact secure session and CSRF cookie attributes", async () => {
    const { app, repository } = await authApp();
    try {
      const response = await app.inject({ method: "POST", url: "/api/admin/auth/login",
        payload: { email: EMAIL, password: PASSWORD } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ success: true, data: { user_id: 7, email: EMAIL } });
      const cookies = response.headers["set-cookie"] as unknown as string[];
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toMatch(/^__Host-sotoayam_session=.*; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
      expect(cookies[1]).toMatch(/^__Host-sotoayam_csrf=.*; Path=\/; Secure; SameSite=Strict$/);
      expect(cookies.join(";")).not.toMatch(/Max-Age|Domain=/i);
      expect(repository.createInputs).toHaveLength(1);
    } finally { await app.close(); }
  });

  it.each([
    ["unknown email", null, PASSWORD, "UNKNOWN_EMAIL"],
    ["wrong password", "active", "wrong-value", "BAD_PASSWORD"],
    ["inactive user", "inactive", PASSWORD, "INACTIVE_USER"],
  ] as const)("returns an identical response for %s", async (_label, stored, password, reason) => {
    const repository = new FakeSessionRepository();
    repository.credential = stored === "inactive" ? credential(false) : stored === "active" ? credential() : stored;
    const { app } = await authApp(repository);
    try {
      const response = await app.inject({ method: "POST", url: "/api/admin/auth/login",
        payload: { email: EMAIL, password } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ success: false,
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } });
      expect(repository.failures).toEqual([reason]);
    } finally { await app.close(); }
  });

  it("runs the same costly verification class for unknown-email and wrong-password attempts", async () => {
    const timings: Record<"unknown" | "wrong", number[]> = { unknown: [], wrong: [] };
    for (const kind of ["unknown", "wrong", "unknown", "wrong"] as const) {
      const repository = new FakeSessionRepository();
      repository.credential = kind === "unknown" ? null : credential();
      const started = performance.now();
      await expect(new AdminAuthenticationService(repository, 43_200).login({ email: EMAIL,
        password: "not-the-password", clientIp: "127.0.0.1" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      timings[kind].push(performance.now() - started);
    }
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const ratio = average(timings.unknown) / average(timings.wrong);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("returns Retry-After when the database-backed cooldown gate is locked", async () => {
    const repository = new FakeSessionRepository();
    repository.gate = { locked: true, retryAfterSeconds: 123 };
    const { app } = await authApp(repository);
    try {
      const response = await app.inject({ method: "POST", url: "/api/admin/auth/login",
        payload: { email: EMAIL, password: PASSWORD } });
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("123");
      expect(repository.failures).toEqual(["LOCKED_OUT"]);
    } finally { await app.close(); }
  });

  it("authenticates from a hashed cookie and enforces CSRF only on mutations", async () => {
    const repository = new FakeSessionRepository();
    repository.validated = { sessionId: SESSION_ID, userId: 7, email: EMAIL, displayName: "Primary Admin",
      expiresAt: "2026-09-09T12:00:00.000Z", csrfTokenHash: hashOpaqueToken("csrf-value") };
    const authenticator = new DatabaseAdminSessionAuthenticator(repository, false, 3_600);
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await app.register(defineAdminRoutes(async (scope) => {
      scope.get("/value", async (request) => request.adminPrincipal);
      scope.post("/value", async () => ({ ok: true }));
    }), { sessionAuthenticator: authenticator, adminApiKeyFallbackEnabled: false });
    try {
      const headers = { cookie: "sotoayam_session=raw-session-value" };
      expect((await app.inject({ method: "GET", url: "/value", headers })).json())
        .toMatchObject({ kind: "session", adminUserId: 7 });
      expect((await app.inject({ method: "POST", url: "/value", headers })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/value", headers: { ...headers, "x-csrf-token": "wrong" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/value", headers: { ...headers, "x-csrf-token": "csrf-value" } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("logs out with revocation and cookie clearing and is idempotent without a session", async () => {
    const repository = new FakeSessionRepository();
    repository.validated = { sessionId: SESSION_ID, userId: 7, email: EMAIL, displayName: "Primary Admin",
      expiresAt: "2026-09-09T12:00:00.000Z", csrfTokenHash: hashOpaqueToken("csrf-value") };
    const { app } = await authApp(repository, false);
    try {
      const first = await app.inject({ method: "POST", url: "/api/admin/auth/logout",
        headers: { cookie: "sotoayam_session=raw", "x-csrf-token": "csrf-value" } });
      expect(first.statusCode).toBe(204);
      expect(repository.revoked).toEqual([{ sessionId: SESSION_ID, reason: "LOGOUT", actorUserId: 7 }]);
      const cleared = first.headers["set-cookie"] as unknown as string[];
      expect(cleared).toHaveLength(2);
      expect(cleared.every((value) => /Expires=Thu, 01 Jan 1970/.test(value))).toBe(true);
      expect(cleared.every((value) => /Max-Age=0/.test(value))).toBe(true);
      repository.validated = null;
      expect((await app.inject({ method: "POST", url: "/api/admin/auth/logout" })).statusCode).toBe(204);
    } finally { await app.close(); }
  });

  it("returns the current principal, lists only non-secret session data, and revokes an own session", async () => {
    const repository = new FakeSessionRepository();
    repository.validated = { sessionId: SESSION_ID, userId: 7, email: EMAIL, displayName: "Primary Admin",
      expiresAt: "2026-09-09T12:00:00.000Z", csrfTokenHash: hashOpaqueToken("csrf-value") };
    repository.summaries = [{ sessionId: SESSION_ID, issuedAt: "2026-09-09T00:00:00.000Z",
      expiresAt: "2026-09-09T12:00:00.000Z", lastSeenAt: "2026-09-09T01:00:00.000Z",
      revokedAt: null, revokedReason: null, clientIp: null, userAgentDigest: null }];
    const { app } = await authApp(repository, false);
    const headers = { cookie: "sotoayam_session=raw", "x-csrf-token": "csrf-value" };
    try {
      expect((await app.inject({ method: "GET", url: "/api/admin/auth/session", headers })).json())
        .toEqual({ success: true, data: { user_id: 7, email: EMAIL, display_name: "Primary Admin",
          expires_at: "2026-09-09T12:00:00.000Z" } });
      const listed = (await app.inject({ method: "GET", url: "/api/admin/auth/sessions", headers })).json();
      expect(listed).toMatchObject({ success: true, data: [{ sessionId: SESSION_ID, current: true }] });
      expect(JSON.stringify(listed)).not.toMatch(/token|hash/i);
      expect((await app.inject({ method: "DELETE", url: `/api/admin/auth/sessions/${SESSION_ID}`, headers })).statusCode).toBe(204);
      expect(repository.revoked.at(-1)).toEqual({ sessionId: SESSION_ID, reason: "REVOKED_BY_ADMIN", actorUserId: 7 });
    } finally { await app.close(); }
  });

  it("changes a password only after current-password verification and keeps only the calling session", async () => {
    const repository = new FakeSessionRepository();
    const service = new AdminAuthenticationService(repository, 43_200);
    await service.changePassword(principal(), { currentPassword: PASSWORD, newPassword: "New-Strong-Password-88!" });
    expect(repository.changed[0]).toBe(7);
    expect(repository.changed[1]).toBe("scrypt");
    expect(repository.changed[2]).not.toContain("New-Strong-Password-88!");
    expect(repository.changed[3]).toBe(7);
    expect(repository.changed[4]).toBe(SESSION_ID);
    await expect(service.changePassword(principal(), { currentPassword: "wrong", newPassword: "New-Strong-Password-88!" }))
      .rejects.toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
  });

  it("allows the server-only password reset path even while login cooldown is active", async () => {
    const repository = new FakeSessionRepository();
    repository.gate = { locked: true, retryAfterSeconds: 900 };
    await new AdminAuthenticationService(repository, 43_200)
      .resetPassword(EMAIL, "Recovery-Password-94!");
    expect(repository.changed[0]).toBe(7);
    expect(repository.changed[4]).toBeNull();
    expect(repository.failures).toEqual([]);
  });

  it("uses a session before fallback and refuses fallback when disabled", async () => {
    const session = principal();
    const request = { headers: { "x-admin-api-key": "matching-key" } } as unknown as FastifyRequest;
    const fallback = vi.fn();
    expect(await resolveAdminPrincipal(request, { adminApiKey: "matching-key", sessionAuthenticator: {
      authenticate: async () => session, verifyCsrf: () => true,
    }, onApiKeyFallback: fallback })).toBe(session);
    expect(fallback).not.toHaveBeenCalled();
    await expect(resolveAdminPrincipal(request, { adminApiKey: "matching-key", adminApiKeyFallbackEnabled: false }))
      .rejects.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
  });

  it("logs and audits API-key compatibility fallback once per process", async () => {
    const append = vi.fn().mockResolvedValue({});
    const warn = vi.fn();
    const service = new AdminAuthenticationService(new FakeSessionRepository(), 43_200, { append } as never, warn);
    await service.observeApiKeyFallback();
    await service.observeApiKeyFallback();
    expect(warn).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_API_KEY_FALLBACK_USED",
      actor_type: "SYSTEM", actor_user_id: null }));
  });

  it("resolves the authenticated admin by id even when two SYSTEM_ADMIN users exist", async () => {
    const findTrustedAdminActorUser = vi.fn().mockRejectedValue(new Error("singleton path must not run"));
    const findById = vi.fn().mockResolvedValue({ id: 22, displayName: "Second Admin", active: true,
      divisionId: 1, divisionCode: "OPERATIONS", divisionGrantsSystemAuthority: true,
      roleId: 2, roleCode: "ADMIN" });
    const resolver = new TrustedTaskActorService({ findTrustedAdminActorUser, findById,
      hasActiveSystemAdminAuthority: vi.fn().mockResolvedValue(true) } as never,
    { findForRoleCode: vi.fn().mockResolvedValue([{ code: "task.read", active: true }]) } as never);
    const resolved = await resolver.resolveActor({ ...principal(), adminUserId: 22 } as AdminPrincipal);
    expect(resolved.id).toBe(22);
    expect(findById).toHaveBeenCalledWith(22);
    expect(findTrustedAdminActorUser).not.toHaveBeenCalled();
  });

  it("rejects a session principal that lacks active SYSTEM_ADMIN capability", async () => {
    const resolver = new TrustedTaskActorService({ findTrustedAdminActorUser: vi.fn(),
      findById: vi.fn().mockResolvedValue({ id: 7, displayName: "Admin", active: true, divisionId: 2,
        divisionCode: "SALES", divisionGrantsSystemAuthority: false, roleId: 2, roleCode: "ADMIN" }),
      hasActiveSystemAdminAuthority: vi.fn().mockResolvedValue(false) } as never,
    { findForRoleCode: vi.fn() } as never);
    await expect(resolver.resolveActor(principal())).rejects.toMatchObject({ statusCode: 403, code: "ADMIN_AUTHORITY_REQUIRED" });
  });

  it("defines the additive migration contract and all eight service-only RPCs", async () => {
    const sql = await readFile(path.resolve("supabase/migrations/202609100001_create_admin_session_authentication.sql"), "utf8");
    expect(sql).toContain("create table public.admin_sessions");
    expect(sql).toContain("create table public.admin_login_attempts");
    expect(sql.match(/enable row level security/g)).toHaveLength(2);
    expect(sql).not.toMatch(/create\s+policy/i);
    for (const name of ["evaluate_admin_login_gate", "record_admin_login_failure", "create_admin_session",
      "validate_admin_session", "revoke_admin_session", "revoke_admin_sessions_for_user",
      "change_admin_password", "list_admin_sessions"]) {
      expect(sql).toContain(`create function public.${name}`);
      expect(sql).toContain(`grant execute on function public.${name}`);
    }
    expect(sql).toContain("offset 10");
    expect(sql).toContain("revoked_reason = 'SUPERSEDED'");
    expect(sql).toContain("last_seen_at <= now() - make_interval(secs => p_touch_after_seconds)");
    expect(sql).toContain("u.active");
    expect(sql).not.toMatch(/alter\s+table\s+public\.(?!admin_sessions|admin_login_attempts)/i);
  });
});
