import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../src/errors.js";
import { adminNotificationsRoutes } from "../../src/routes/admin-notifications.routes.js";
import { AdminTestNotificationService } from "../../src/services/admin-test-notification.service.js";

const requestUuid = "00000000-0000-4000-8000-000000000001";
const legacy = [{ id: 11 }, { id: 12 }];
const normalized = { id: 7, legacy_telegram_user_id: 12, display_name: "Penerima",
  divisions: { active: true }, roles: { active: true } };

function fixture() {
  const query = { in: vi.fn(), eq: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn() };
  query.in.mockReturnValue(query); query.eq.mockReturnValue(query);
  query.limit.mockResolvedValue({ data: [normalized], error: null });
  query.maybeSingle.mockResolvedValue({ data: normalized, error: null });
  const client = { from: vi.fn(() => ({ select: () => query })) } as unknown as SupabaseClient;
  const resolver = { resolve: vi.fn().mockResolvedValue(legacy) };
  const intake = { send: vi.fn().mockResolvedValue({ recipients: 1, sent: 1, failed: 0, duplicate: false }) };
  const audit = { append: vi.fn().mockResolvedValue({}) };
  const service = new AdminTestNotificationService(client, resolver as never, intake as never, audit as never);
  return { service, query, resolver, intake, audit };
}

describe("SYSTEM_ADMIN test notification", () => {
  it("offers only mapped active eligible recipients without chat IDs", async () => {
    const h = fixture();
    expect(await h.service.recipients("SYSTEM_ERROR")).toEqual([{ id: 7, display_name: "Penerima" }]);
    expect(h.query.in).toHaveBeenCalledWith("legacy_telegram_user_id", [11, 12]);
    expect(JSON.stringify(await h.service.recipients("SYSTEM_ERROR"))).not.toMatch(/telegram_chat_id|legacy_telegram_user_id/);
  });

  it("sends only a fixed SYSTEM_ERROR payload and attributes the real actor", async () => {
    const h = fixture();
    expect(await h.service.send(7, requestUuid, 9, "http-1", "SYSTEM_ERROR")).toMatchObject({
      recipient_user_id: 7, type: "SYSTEM_ERROR", sent: 1, failed: 0 });
    expect(h.intake.send).toHaveBeenCalledWith(expect.objectContaining({
      event_id: `admin-test:${requestUuid}`, type: "SYSTEM_ERROR",
      metadata: { test_recipient_user_id: 7 } }), null, { requestId: "http-1" }, 12);
    expect(h.audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actor_type: "USER", actor_user_id: 9, action: "TEST_NOTIFICATION_REQUESTED" }));
  });

  it("rejects malformed IDs and inactive recipients without intake or audit", async () => {
    const h = fixture();
    await expect(h.service.send(7, "not-a-uuid", 9, "http-1", "SYSTEM_ERROR")).rejects.toMatchObject({ statusCode: 400 });
    h.query.maybeSingle.mockResolvedValue({ data: { ...normalized, divisions: { active: false } }, error: null });
    await expect(h.service.send(7, requestUuid, 9, "http-1", "SYSTEM_ERROR")).rejects.toMatchObject({ code: "TEST_RECIPIENT_UNAVAILABLE" });
    await expect(h.service.recipients("UNKNOWN")).rejects.toMatchObject({ statusCode: 400 });
    expect(h.intake.send).not.toHaveBeenCalled(); expect(h.audit.append).not.toHaveBeenCalled();
  });

  it("requires a session, CSRF, and effective SYSTEM_ADMIN, excluding the shared key", async () => {
    const testService = { recipients: vi.fn().mockResolvedValue([{ id: 7, display_name: "Penerima" }]),
      send: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }) };
    const actor = { id: 9, displayName: "Admin", active: true, divisionId: 1, divisionCode: "IT",
      roleId: 1, roleCode: "ADMIN", permissions: new Set<string>(), divisionGrantsSystemAuthority: true };
    let authenticated = false; let csrf = true; let effective = true;
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      const known = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR", "Unexpected");
      return reply.status(known.statusCode).send({ error: { code: known.code } });
    });
    await app.register(adminNotificationsRoutes, { service: {} as never,
      actorResolver: { resolveTrustedActor: vi.fn().mockResolvedValue(actor),
        resolveActor: vi.fn(async () => ({ ...actor, divisionGrantsSystemAuthority: effective })) },
      testService: testService as never, adminApiKey: "a".repeat(32), adminApiKeyFallbackEnabled: true,
      sessionAuthenticator: { authenticate: vi.fn(async () => authenticated ? {
        kind: "session" as const, adminUserId: 9, sessionId: "session", email: "admin@example.test",
        displayName: "Admin", expiresAt: "2099-01-01" } : null),
      verifyCsrf: vi.fn(() => csrf) } });
    try {
      const body = { recipient_user_id: 7, request_id: requestUuid, type: "SYSTEM_ERROR" };
      expect((await app.inject({ method: "POST", url: "/test", payload: body })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/test", payload: body,
        headers: { "x-admin-api-key": "a".repeat(32) } })).statusCode).toBe(401);
      authenticated = true; csrf = false;
      expect((await app.inject({ method: "POST", url: "/test", payload: body })).statusCode).toBe(403);
      csrf = true; effective = false;
      expect((await app.inject({ method: "POST", url: "/test", payload: body })).statusCode).toBe(403);
      effective = true;
      expect((await app.inject({ method: "GET", url: "/test-recipients?type=SYSTEM_ERROR" })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/test", payload: body })).statusCode).toBe(200);
      expect(testService.send).toHaveBeenCalledOnce();
      expect(testService.send).toHaveBeenCalledWith(7, requestUuid, 9, expect.any(String), "SYSTEM_ERROR");
    } finally { await app.close(); }
  });
});
