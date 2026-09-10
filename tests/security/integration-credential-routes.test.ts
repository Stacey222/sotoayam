import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { generateIntegrationCredential, type IntegrationPrincipal } from "../../src/auth/integration-credential.js";
import type { SessionPrincipal } from "../../src/auth/admin-session.js";
import { DEFAULT_CRITICAL_ALERT_POLICY } from "../../src/alerts/policy.js";
import type { AppConfig } from "../../src/config/env.js";
import { AppError, RateLimitedError } from "../../src/errors.js";
import { registerRateLimit } from "../../src/http/rate-limit-plugin.js";
import { integrationAdministrationRoutes } from "../../src/routes/integration-administration.routes.js";
import { internalTaskIngestionRoutes } from "../../src/routes/task-ingestion.routes.js";

const session: SessionPrincipal = { kind: "session", adminUserId: 5,
  sessionId: "00000000-0000-4000-8000-000000000005", email: "admin@example.com", displayName: "Admin",
  expiresAt: "2099-01-01T00:00:00.000Z" };
const actor = { id: 5, displayName: "Admin", active: true, divisionId: 1, divisionCode: "IT",
  roleId: 1, roleCode: "ADMIN", permissions: new Set<string>() };
const metadata = { id: 9, integration_id: 7, selector: "0000000000000001", label: "production",
  created_at: "2026-09-10T00:00:00.000Z", created_by_user_id: 5, last_used_at: null, expires_at: null,
  revoked_at: null, revoked_reason: null, rotation_of_credential_id: null, status: "ACTIVE" };

function adminService() {
  return { listCredentials: vi.fn().mockResolvedValue([metadata]),
    createCredential: vi.fn().mockResolvedValue({ ...metadata,
      credential: `soto_${"ik"}_${metadata.selector}_${"A".repeat(43)}` }),
    revokeCredential: vi.fn().mockResolvedValue({ ...metadata, revoked_at: "2026-09-10T01:00:00.000Z",
      revoked_reason: "ROTATED", status: "REVOKED" }) };
}

async function adminApp(service = adminService(), csrf = true, logger: false | Record<string, unknown> = false) {
  const app = Fastify({ logger: logger as never });
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR", "Unexpected");
    return reply.status(known.statusCode).send({ success: false, error: { code: known.code, message: known.message } });
  });
  await app.register(integrationAdministrationRoutes, { service: service as never,
    actorResolver: { resolveTrustedActor: vi.fn(), resolveActor: vi.fn().mockResolvedValue(actor) },
    sessionAuthenticator: { authenticate: vi.fn().mockResolvedValue(session), verifyCsrf: vi.fn().mockReturnValue(csrf) },
    adminApiKeyFallbackEnabled: false });
  return app;
}

function rateConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { supabaseUrl: "https://example.supabase.co", supabaseServiceRoleKey: "test", telegramBotToken: "test",
    internalApiKey: "legacy", port: 3000, telegramPollingEnabled: false, reminderSchedulerEnabled: false,
    reminderSchedulerIntervalSeconds: 300, businessTimeZone: "UTC", criticalAlertEvaluatorEnabled: false,
    criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY, logLevel: "silent", sessionAbsoluteTtlSeconds: 43_200,
    sessionIdleTtlSeconds: 3_600, sessionCookieSecure: true, trustProxy: true, adminApiKeyFallbackEnabled: false,
    rateLimitEnabled: true, rateLimitLoginPerMinute: 5, rateLimitLoginGlobalPerMinute: 60,
    rateLimitAdminReadPerMinute: 300, rateLimitAdminWritePerMinute: 60, rateLimitAdminExpensivePerMinute: 10,
    rateLimitInternalPerMinute: 1, rateLimitAuthFailurePerMinute: 2, rateLimitSharedOriginFactor: 10,
    rateLimitMaxKeys: 10_000, rateLimitTrustedIps: [], ...overrides };
}

describe("P1-04 credential administration routes", () => {
  it("P4-19 requires a session and preserves CSRF on both mutations", async () => {
    const service = adminService(); const app = await adminApp(service, false);
    try {
      expect((await app.inject({ method: "GET", url: "/7/credentials" })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/7/credentials", payload: { label: "prod" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/7/credentials/9/revoke", payload: {} })).statusCode).toBe(403);
      expect(service.createCredential).not.toHaveBeenCalled(); expect(service.revokeCredential).not.toHaveBeenCalled();
    } finally { await app.close(); }
    const keyOnly = Fastify({ logger: false });
    await keyOnly.register(integrationAdministrationRoutes, { service: service as never, actorResolver: {} as never,
      adminApiKey: "a".repeat(32), adminApiKeyFallbackEnabled: true });
    try { expect((await keyOnly.inject({ method: "GET", url: "/7/credentials",
      headers: { "x-admin-api-key": "a".repeat(32) } })).statusCode).toBe(401); } finally { await keyOnly.close(); }
  });

  it("P4-20 returns the raw credential exactly once and prevents response caching", async () => {
    const service = adminService(); const app = await adminApp(service);
    try {
      const created = await app.inject({ method: "POST", url: "/7/credentials", payload: { label: "production" } });
      expect(created.statusCode).toBe(201); expect(created.headers["cache-control"]).toBe("no-store");
      expect(created.json().data.credential).toMatch(/^soto_ik_/);
      const listed = await app.inject({ method: "GET", url: "/7/credentials" });
      expect(listed.json().data[0].credential).toBeUndefined(); expect(listed.body).not.toContain("secret_hash");
      expect(listed.body).not.toContain(created.json().data.credential);
      expect((created.body.match(/soto_ik_/g) ?? [])).toHaveLength(1);
    } finally { await app.close(); }
  });

  it("P4-22 shares budgets by integration, isolates integrations, and penalizes repeated 401s", async () => {
    const first = generateIntegrationCredential((n) => Buffer.alloc(n, 3));
    const second = generateIntegrationCredential((n) => Buffer.alloc(n, 4));
    const third = generateIntegrationCredential((n) => Buffer.alloc(n, 5));
    const bySelector = new Map([[first.selector, 7], [second.selector, 7], [third.selector, 8]]);
    const authenticate = vi.fn(async (selector: string, _secretHash: string, _capability: unknown) => {
      const id = bySelector.get(selector);
      return id ? { status: "OK" as const, principal: { integrationId: id, credentialId: id,
        code: `INT_${id}`, source: "AUTOMATION" as const, requestingDivisionId: id } } : { status: "BAD_SECRET" as const, principal: null };
    });
    const makeApp = async (config: AppConfig) => {
      const instance = Fastify({ logger: false, trustProxy: true });
      await registerRateLimit(instance, { config });
      instance.setErrorHandler((error, _request, reply) => {
        const known = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR", "Unexpected");
        return reply.status(known.statusCode).send({ code: known.code });
      });
      await instance.register(internalTaskIngestionRoutes, { service: { ingestAutomation: vi.fn().mockResolvedValue({}) } as never,
        integrations: {} as never, internalApiKey: "legacy", internalApiKeyFallbackEnabled: false,
        credentials: { authenticate: async (raw, capability) => {
        const parsed = /^soto_ik_([^_]+)_/.exec(String(raw));
        const result = await authenticate(parsed?.[1] ?? "", "", capability);
        if (result.status !== "OK") throw new AppError(401, "INTEGRATION_UNAUTHORIZED", "Invalid or missing integration credential");
        return result.principal as IntegrationPrincipal;
        } } });
      return instance;
    };
    const app = await makeApp(rateConfig());
    const call = (credential: string, ip: string) => app.inject({ method: "POST", url: "/tasks",
      headers: { "x-integration-key": credential, "x-forwarded-for": ip }, payload: { title: "T", owner_division: "OPS" } });
    try {
      expect((await call(first.credential, "192.0.2.1")).statusCode).toBe(200);
      expect((await call(second.credential, "192.0.2.2")).statusCode).toBe(429);
      expect((await call(third.credential, "192.0.2.3")).statusCode).toBe(200);
    } finally { await app.close(); }
    const penaltyApp = await makeApp(rateConfig({ rateLimitInternalPerMinute: 100 }));
    const penalized = (selector: string) => penaltyApp.inject({ method: "POST", url: "/tasks",
      headers: { "x-integration-key": `soto_${"ik"}_${selector.repeat(16)}_${selector.toUpperCase().repeat(43)}`,
        "x-forwarded-for": "192.0.2.9" }, payload: { title: "T", owner_division: "OPS" } });
    try {
      expect((await penalized("z")).statusCode).toBe(401);
      expect((await penalized("y")).statusCode).toBe(401);
      expect((await penalized("x")).statusCode).toBe(429);
    } finally { await penaltyApp.close(); }
  });

  it("P4-23 never emits plaintext integration credentials or their prefix to logs", async () => {
    let logs = ""; const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
    const service = adminService(); const app = await adminApp(service, true, { level: "info", stream });
    let raw = "";
    try {
      const response = await app.inject({ method: "POST", url: "/7/credentials", payload: { label: "production" } });
      raw = response.json().data.credential as string;
      expect(response.statusCode).toBe(201); expect(logs).not.toContain(raw); expect(logs).not.toContain("soto_ik_");
    } finally { await app.close(); }
    const failureApp = Fastify({ logger: { level: "info", stream } as never });
    await failureApp.register(internalTaskIngestionRoutes, { service: {} as never, integrations: {} as never,
      internalApiKey: "legacy", internalApiKeyFallbackEnabled: false,
      credentials: { authenticate: vi.fn().mockRejectedValue(new AppError(401, "INTEGRATION_UNAUTHORIZED",
        "Invalid or missing integration credential")) } });
    try {
      expect((await failureApp.inject({ method: "POST", url: "/tasks", headers: { "x-integration-key": raw },
        payload: {} })).statusCode).toBe(401);
      expect(logs).not.toContain(raw); expect(logs).not.toContain("soto_ik_");
    } finally { await failureApp.close(); }
  });
});
