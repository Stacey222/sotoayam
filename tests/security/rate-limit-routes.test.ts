import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRITICAL_ALERT_POLICY } from "../../src/alerts/policy.js";
import { defineAdminRoutes } from "../../src/auth/admin-authorization.js";
import type { SessionPrincipal } from "../../src/auth/admin-session.js";
import type { AppConfig } from "../../src/config/env.js";
import { AppError, RateLimitedError } from "../../src/errors.js";
import { registerRateLimit } from "../../src/http/rate-limit-plugin.js";
import { adminAuthRoutes } from "../../src/routes/admin-auth.routes.js";
import { adminNotificationsRoutes } from "../../src/routes/admin-notifications.routes.js";
import { adminUserManagementRoutes } from "../../src/routes/admin-user-management.routes.js";
import { collaborationRulesRoutes } from "../../src/routes/collaboration-rules.routes.js";
import { adminCriticalAlertRoutes, criticalAlertsRoutes } from "../../src/routes/critical-alerts.routes.js";
import { healthRoutes } from "../../src/routes/health.routes.js";
import { integrationAdministrationRoutes } from "../../src/routes/integration-administration.routes.js";
import { notificationRoutes } from "../../src/routes/notifications.routes.js";
import { reportsRoutes } from "../../src/routes/reports.routes.js";
import { systemAuthorityRoutes } from "../../src/routes/system-authority.routes.js";
import { csvImportRoutes, internalTaskIngestionRoutes } from "../../src/routes/task-ingestion.routes.js";
import { tasksRoutes } from "../../src/routes/tasks.routes.js";
import { taxonomyRoutes } from "../../src/routes/taxonomy.routes.js";
import { usersRoutes } from "../../src/routes/users.routes.js";
import { LoginThrottledError } from "../../src/services/admin-authentication.service.js";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return { supabaseUrl: "https://example.supabase.co", supabaseServiceRoleKey: "test-service-key",
    telegramBotToken: "test-token", internalApiKey: "internal", adminApiKey: "a".repeat(32), host: "0.0.0.0", port: 3000,
    telegramPollingEnabled: false, reminderSchedulerEnabled: false, reminderSchedulerIntervalSeconds: 300,
    businessTimeZone: "UTC", criticalAlertEvaluatorEnabled: false, criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY,
    logLevel: "silent", sessionAbsoluteTtlSeconds: 43_200, sessionIdleTtlSeconds: 3_600,
    sessionCookieSecure: true, trustProxy: true, adminApiKeyFallbackEnabled: true,
    rateLimitEnabled: true, rateLimitLoginPerMinute: 5, rateLimitLoginGlobalPerMinute: 60,
    rateLimitAdminReadPerMinute: 300, rateLimitAdminWritePerMinute: 60, rateLimitAdminExpensivePerMinute: 10,
    rateLimitInternalPerMinute: 600, rateLimitAuthFailurePerMinute: 30, rateLimitSharedOriginFactor: 10,
    rateLimitMaxKeys: 10_000, rateLimitTrustedIps: [], ...overrides };
}

async function limitedApp(appConfig: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: appConfig.trustProxy });
  await app.register(fastifyCookie);
  await registerRateLimit(app, { config: appConfig });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RateLimitedError) {
      reply.header("Retry-After", String(error.retryAfterSeconds));
      if (error.rateLimit) reply.headers({ "RateLimit-Limit": String(error.rateLimit.limit),
        "RateLimit-Remaining": String(error.rateLimit.remaining), "RateLimit-Reset": String(error.rateLimit.resetSeconds) });
    }
    const known = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR", "Unexpected");
    return reply.status(known.statusCode).send({ success: false, error: { code: known.code, message: known.message } });
  });
  return app;
}

const principal = (user = 1, session = "00000000-0000-4000-8000-000000000001"): SessionPrincipal => ({
  kind: "session", adminUserId: user, sessionId: session, email: `admin${user}@example.com`, displayName: `Admin ${user}`,
  expiresAt: "2099-01-01T00:00:00.000Z",
});

describe("P1-03 route enforcement", () => {
  it("RL-07/RL-08 rejects the sixth login before P1-01 gate/failure work", async () => {
    const app = await limitedApp(config({ rateLimitAuthFailurePerMinute: 100 }));
    const repository = { evaluateLoginGate: vi.fn(), recordLoginFailure: vi.fn() };
    const service = { login: vi.fn(async () => {
      await repository.evaluateLoginGate();
      await repository.recordLoginFailure();
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }) };
    await app.register(adminAuthRoutes, { prefix: "/api/admin/auth", service: service as never,
      authenticator: {} as never, cookieSecure: true });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: {} })).statusCode).toBe(401);
      }
      const response = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: {} });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ success: false, error: { code: "RATE_LIMITED", message: "Too many requests" } });
      expect(Number(response.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(repository.evaluateLoginGate).toHaveBeenCalledTimes(5);
      expect(repository.recordLoginFailure).toHaveBeenCalledTimes(5);
    } finally { await app.close(); }
  });

  it("RL-09 preserves LOGIN_THROTTLED as a distinct contract", async () => {
    const app = await limitedApp(config());
    await app.register(adminAuthRoutes, { prefix: "/api/admin/auth",
      service: { login: vi.fn().mockRejectedValue(new LoginThrottledError(77)) } as never,
      authenticator: {} as never, cookieSecure: true });
    try {
      const response = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: {} });
      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe("LOGIN_THROTTLED");
      expect(response.headers["retry-after"]).toBe("77");
    } finally { await app.close(); }
  });

  it("RL-10 gates later ADMIN_API_KEY attempts after repeated 401 penalties", async () => {
    const app = await limitedApp(config({ rateLimitAuthFailurePerMinute: 3 }));
    const reached = vi.fn();
    await app.register(defineAdminRoutes(async (scope) => { scope.get("/", async () => { reached(); return {}; }); }),
      { prefix: "/admin", adminApiKey: "a".repeat(32) });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await app.inject({ url: "/admin", headers: { "x-admin-api-key": "wrong" } })).statusCode).toBe(401);
      }
      const blocked = await app.inject({ url: "/admin", headers: { "x-admin-api-key": "wrong" } });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe("RATE_LIMITED");
      expect(reached).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("RL-11 assigns every auth/admin route structurally without default fallback", async () => {
    const app = await limitedApp(config());
    const auth = { adminApiKey: "a".repeat(32) };
    const registrations: Array<[never, string]> = [
      [usersRoutes as never, "/api/users"], [adminUserManagementRoutes as never, "/api/admin/users"],
      [systemAuthorityRoutes as never, "/api/admin/system-authority"], [collaborationRulesRoutes as never, "/api/admin/collaboration-rules"],
      [integrationAdministrationRoutes as never, "/api/admin/integrations"], [tasksRoutes as never, "/api/tasks"],
      [csvImportRoutes as never, "/api/tasks/import"], [adminNotificationsRoutes as never, "/api/admin/notifications"],
      [reportsRoutes as never, "/api/reports"], [criticalAlertsRoutes as never, "/api/alerts"],
      [adminCriticalAlertRoutes as never, "/api/admin/alerts"], [taxonomyRoutes as never, "/api/admin"],
    ];
    for (const [plugin, prefix] of registrations) await app.register(plugin, { prefix, ...auth } as never);
    await app.register(adminAuthRoutes, { prefix: "/api/admin/auth", service: {} as never, authenticator: {} as never,
      cookieSecure: true });
    await app.ready();
    try {
      const relevant = app.rateLimitRouteManifest!.filter((entry) => entry.url.startsWith("/api/"));
      expect(relevant.length).toBeGreaterThan(20);
      expect(relevant.filter((entry) => entry.policy === "default")).toEqual([]);
      expect(relevant.some((entry) => entry.policy === "admin-expensive")).toBe(true);
    } finally { await app.close(); }
  });

  it("RL-12 keys admin writes by user id across sessions and separates administrators", async () => {
    const app = await limitedApp(config({ rateLimitAdminWritePerMinute: 10 }));
    const authenticator = { authenticate: async (request: { headers: Record<string, unknown> }) => {
      const raw = String(request.headers["x-test-principal"]);
      const [user, session] = raw.split(":");
      return principal(Number(user), `00000000-0000-4000-8000-${String(session).padStart(12, "0")}`);
    }, verifyCsrf: () => true };
    await app.register(defineAdminRoutes(async (scope) => { scope.post("/", async () => ({ ok: true })); }),
      { prefix: "/admin", sessionAuthenticator: authenticator });
    try {
      for (const session of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect((await app.inject({ method: "POST", url: "/admin",
        headers: { "x-test-principal": `1:${session}`, "x-forwarded-for": `192.0.2.${session}` } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/admin",
        headers: { "x-test-principal": "1:11", "x-forwarded-for": "192.0.2.30" } })).statusCode).toBe(429);
      expect((await app.inject({ method: "POST", url: "/admin",
        headers: { "x-test-principal": "2:1", "x-forwarded-for": "192.0.2.31" } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("RL-13 keeps health exempt under sustained traffic", async () => {
    const app = await limitedApp(config({ rateLimitLoginPerMinute: 1 }));
    await app.register(healthRoutes);
    try {
      for (let request = 0; request < 200; request += 1) expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("RL-14 keeps admin read and write budgets independent", async () => {
    const app = await limitedApp(config({ rateLimitAdminReadPerMinute: 2, rateLimitAdminWritePerMinute: 2 }));
    const authenticator = { authenticate: async () => principal(), verifyCsrf: () => true };
    await app.register(defineAdminRoutes(async (scope) => {
      scope.get("/", async () => ({})); scope.post("/", async () => ({}));
    }), { prefix: "/admin", sessionAuthenticator: authenticator });
    try {
      for (let index = 1; index <= 2; index += 1) expect((await app.inject({ url: "/admin",
        headers: { "x-forwarded-for": `192.0.2.${index}` } })).statusCode).toBe(200);
      expect((await app.inject({ url: "/admin", headers: { "x-forwarded-for": "192.0.2.9" } })).statusCode).toBe(429);
      expect((await app.inject({ method: "POST", url: "/admin", headers: { "x-forwarded-for": "192.0.2.10" } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("RL-15 fixes password changes at five per 15 minutes independently of login", async () => {
    const app = await limitedApp(config());
    const changePassword = vi.fn().mockResolvedValue(undefined);
    await app.register(adminAuthRoutes, { prefix: "/api/admin/auth", service: { changePassword } as never,
      authenticator: { authenticate: async () => principal(), verifyCsrf: () => true }, cookieSecure: true });
    try {
      for (let index = 1; index <= 5; index += 1) expect((await app.inject({ method: "POST", url: "/api/admin/auth/password",
        headers: { "x-forwarded-for": `192.0.2.${index}` }, payload: {} })).statusCode).toBe(204);
      const blocked = await app.inject({ method: "POST", url: "/api/admin/auth/password",
        headers: { "x-forwarded-for": "192.0.2.20" }, payload: {} });
      expect(blocked.statusCode).toBe(429);
      expect(changePassword).toHaveBeenCalledTimes(5);
    } finally { await app.close(); }
  });

  it("RL-16 hides budget headers on login/internal and exposes them on authenticated admin limits", async () => {
    const app = await limitedApp(config({ rateLimitLoginPerMinute: 1, rateLimitInternalPerMinute: 1,
      rateLimitAdminWritePerMinute: 1 }));
    await app.register(adminAuthRoutes, { prefix: "/auth", service: { login: vi.fn().mockRejectedValue(new AppError(401, "X", "x")) } as never,
      authenticator: {} as never, cookieSecure: true });
    await app.register(notificationRoutes, { prefix: "/notifications", internalApiKey: "internal",
      notificationService: { send: async () => ({}) } as never });
    await app.register(defineAdminRoutes(async (scope) => { scope.post("/", async () => ({})); }),
      { prefix: "/admin", sessionAuthenticator: { authenticate: async () => principal(), verifyCsrf: () => true } });
    try {
      await app.inject({ method: "POST", url: "/auth/login", payload: {} });
      const login = await app.inject({ method: "POST", url: "/auth/login", payload: {} });
      expect(login.headers["ratelimit-remaining"]).toBeUndefined();
      await app.inject({ method: "POST", url: "/notifications/send", headers: { "x-internal-api-key": "internal" }, payload: {} });
      const internal = await app.inject({ method: "POST", url: "/notifications/send", headers: { "x-internal-api-key": "internal" }, payload: {} });
      expect(internal.headers["ratelimit-remaining"]).toBeUndefined();
      expect((await app.inject({ method: "POST", url: "/admin", headers: { "x-forwarded-for": "192.0.2.1" } })).statusCode).toBe(200);
      const admin = await app.inject({ method: "POST", url: "/admin", headers: { "x-forwarded-for": "192.0.2.2" } });
      expect(admin.statusCode).toBe(429);
      expect(admin.headers["ratelimit-remaining"]).toBe("0");
    } finally { await app.close(); }
  });

  it("keeps the login global backstop independent of client-IP keys", async () => {
    const app = await limitedApp(config({ rateLimitLoginPerMinute: 100, rateLimitLoginGlobalPerMinute: 2 }));
    await app.register(adminAuthRoutes, { prefix: "/auth", service: { login: vi.fn().mockRejectedValue(new AppError(401, "X", "x")) } as never,
      authenticator: {} as never, cookieSecure: true });
    try {
      for (const ip of ["192.0.2.1", "192.0.2.2"]) expect((await app.inject({ method: "POST", url: "/auth/login",
        headers: { "x-forwarded-for": ip }, payload: {} })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/auth/login",
        headers: { "x-forwarded-for": "192.0.2.3" }, payload: {} })).statusCode).toBe(429);
    } finally { await app.close(); }
  });

  it("keys resolved internal automation traffic by integration identity", async () => {
    const app = await limitedApp(config({ rateLimitInternalPerMinute: 1 }));
    const ingestAutomation = vi.fn().mockResolvedValue({ created: true });
    await app.register(internalTaskIngestionRoutes, { prefix: "/internal", internalApiKey: "internal",
      service: { ingestAutomation } as never, integrations: {
        findActiveByCode: vi.fn().mockResolvedValue({ id: 7 }), hasActiveCapability: vi.fn().mockResolvedValue(true),
      } as never });
    const request = (ip: string) => app.inject({ method: "POST", url: "/internal/tasks",
      headers: { "x-internal-api-key": "internal", "x-integration-code": "ERP", "x-forwarded-for": ip },
      payload: { external_reference: "one", title: "Task", owner_division: "OPS" } });
    try {
      expect((await request("192.0.2.1")).statusCode).toBe(200);
      expect((await request("192.0.2.2")).statusCode).toBe(429);
      expect(ingestAutomation).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
});
