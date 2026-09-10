import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRITICAL_ALERT_POLICY } from "../../src/alerts/policy.js";
import type { AppConfig } from "../../src/config/env.js";
import { registerRateLimit } from "../../src/http/rate-limit-plugin.js";
import { defineAdminRoutes } from "../../src/auth/admin-authorization.js";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return { supabaseUrl: "x", supabaseServiceRoleKey: "x", telegramBotToken: "x", internalApiKey: "x",
    adminApiKey: "a".repeat(32), host: "0.0.0.0", port: 3000, telegramPollingEnabled: false,
    reminderSchedulerEnabled: false, reminderSchedulerIntervalSeconds: 300, businessTimeZone: "UTC",
    criticalAlertEvaluatorEnabled: false, criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY, logLevel: "silent",
    sessionAbsoluteTtlSeconds: 43_200, sessionIdleTtlSeconds: 3_600, sessionCookieSecure: true,
    trustProxy: true, adminApiKeyFallbackEnabled: true, rateLimitEnabled: true, rateLimitLoginPerMinute: 5,
    rateLimitLoginGlobalPerMinute: 60, rateLimitAdminReadPerMinute: 300, rateLimitAdminWritePerMinute: 60,
    rateLimitAdminExpensivePerMinute: 10, rateLimitInternalPerMinute: 600, rateLimitAuthFailurePerMinute: 30,
    rateLimitSharedOriginFactor: 10, rateLimitMaxKeys: 10_000, rateLimitTrustedIps: [], ...overrides };
}

describe("P1-03 fail-safe", () => {
  it("RL-17 allows requests if the limiter throws", async () => {
    const app = Fastify({ logger: false });
    const failing = { consume: () => { throw new Error("fault"); }, inspect: () => { throw new Error("fault"); },
      sweep: () => 0, clear: vi.fn() };
    await registerRateLimit(app, { config: config(), limiter: failing });
    app.get("/", async () => ({ ok: true }));
    await app.register(defineAdminRoutes(async (scope) => { scope.get("/", async () => ({})); }),
      { prefix: "/admin", adminApiKey: "a".repeat(32) });
    try {
      expect((await app.inject({ url: "/" })).statusCode).toBe(200);
      expect((await app.inject({ url: "/admin", headers: { "x-admin-api-key": "wrong" } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("RL-18 registers no limiter hooks or decorations when disabled", async () => {
    const app = Fastify({ logger: false });
    await registerRateLimit(app, { config: config({ rateLimitEnabled: false }) });
    app.get("/", async () => ({}));
    try {
      for (let index = 0; index < 200; index += 1) expect((await app.inject({ url: "/" })).statusCode).toBe(200);
      expect(app.rateLimitRouteManifest).toBeUndefined();
      expect(app.rateLimitTimerActive).toBeUndefined();
    } finally { await app.close(); }
  });

  it("RL-19 unreferences and clears one sweep timer for every app lifecycle", async () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      for (let run = 0; run < 2; run += 1) {
        const app = Fastify({ logger: false });
        await registerRateLimit(app, { config: config() });
        expect(app.rateLimitTimerActive).toBe(true);
        expect(app.rateLimitTimerReferenced).toBe(false);
        await app.close();
        expect(app.rateLimitTimerActive).toBe(false);
      }
      expect(clear).toHaveBeenCalledTimes(2);
    } finally { clear.mockRestore(); }
  });

  it("RL-21 warns and multiplies IP budgets only in shared-origin mode", async () => {
    const app = Fastify({ logger: false });
    const warn = vi.spyOn(app.log, "warn");
    await registerRateLimit(app, { config: config({ host: "127.0.0.1", trustProxy: false,
      rateLimitLoginPerMinute: 1, rateLimitSharedOriginFactor: 2, rateLimitAdminWritePerMinute: 1 }) });
    app.post("/login", { config: { rateLimit: "login" } }, async () => ({}));
    await app.register(defineAdminRoutes(async (scope) => { scope.post("/", async () => ({})); }),
      { prefix: "/admin", sessionAuthenticator: { authenticate: async () => ({ kind: "session" as const, adminUserId: 1,
        sessionId: "s", email: "a@example.com", displayName: "A", expiresAt: "2099-01-01" }), verifyCsrf: () => true } });
    try {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("shared-origin"));
      expect((await app.inject({ method: "POST", url: "/login" })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/login" })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/login" })).statusCode).toBe(429);
      expect((await app.inject({ method: "POST", url: "/admin" })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/admin" })).statusCode).toBe(429);
    } finally { await app.close(); }
  });

  it("never exempts ADMIN_API_KEY even when its source IP is trusted", async () => {
    const app = Fastify({ logger: false });
    await registerRateLimit(app, { config: config({ host: "127.0.0.1", trustProxy: false,
      rateLimitAdminWritePerMinute: 1, rateLimitTrustedIps: ["127.0.0.1"] }) });
    await app.register(defineAdminRoutes(async (scope) => { scope.post("/", async () => ({})); }),
      { prefix: "/admin", adminApiKey: "a".repeat(32) });
    try {
      const headers = { "x-admin-api-key": "a".repeat(32) };
      expect((await app.inject({ method: "POST", url: "/admin", headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/admin", headers })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
});
