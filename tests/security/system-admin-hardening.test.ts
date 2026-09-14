import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AdminSessionAuthenticator, SessionPrincipal } from "../../src/auth/admin-session.js";
import { AppError } from "../../src/errors.js";
import { adminUserManagementRoutes } from "../../src/routes/admin-user-management.routes.js";
import { systemAuthorityRoutes } from "../../src/routes/system-authority.routes.js";
import { usersRoutes } from "../../src/routes/users.routes.js";
import type { TaskActor } from "../../src/tasks/types.js";

const principal: SessionPrincipal = { kind: "session", adminUserId: 7, sessionId: "session-7",
  email: "admin@example.test", displayName: "Admin", expiresAt: "2026-09-14T00:00:00.000Z" };
const actor: TaskActor = { id: 7, displayName: "Admin", active: true, divisionId: 1,
  divisionCode: "OPERATIONS", divisionGrantsSystemAuthority: true, roleId: 2, roleCode: "ADMIN",
  permissions: new Set() };

const authenticator: AdminSessionAuthenticator = {
  authenticate: vi.fn().mockResolvedValue(principal),
  verifyCsrf: vi.fn().mockReturnValue(true),
};

function authorityService() {
  return { status: vi.fn().mockResolvedValue({}), assign: vi.fn().mockResolvedValue({ id: 10 }),
    revoke: vi.fn().mockResolvedValue({ id: 10 }), setDivisionCapability: vi.fn().mockResolvedValue({ id: 1 }) };
}

describe("P2-00 SYSTEM_ADMIN actor boundary", () => {
  it.each(["/assign", "/revoke"])("rejects shared ADMIN_API_KEY on %s", async (endpoint) => {
    const app = Fastify({ logger: false }); const service = authorityService();
    await app.register(systemAuthorityRoutes, { service: service as never, adminApiKey: "a".repeat(32),
      adminApiKeyFallbackEnabled: true, actorResolver: { resolveTrustedActor: async () => actor } });
    const response = await app.inject({ method: "POST", url: endpoint,
      headers: { "x-admin-api-key": "a".repeat(32) }, payload: { user_id: 8, reason: "handover" } });
    expect(response.statusCode).toBe(401);
    expect(service.assign).not.toHaveBeenCalled(); expect(service.revoke).not.toHaveBeenCalled();
    await app.close();
  });

  it("prevents a demoted session user from re-granting self", async () => {
    const app = Fastify({ logger: false }); const service = authorityService();
    await app.register(systemAuthorityRoutes, { service: service as never, sessionAuthenticator: authenticator,
      adminApiKeyFallbackEnabled: false, actorResolver: { resolveTrustedActor: async () => actor,
        resolveActor: async () => { throw new AppError(403, "ADMIN_AUTHORITY_REQUIRED", "revoked"); } } });
    const response = await app.inject({ method: "POST", url: "/assign", payload: { user_id: 7, reason: "restore" } });
    expect(response.statusCode).toBe(403); expect(service.assign).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["assign", "revoke"] as const)("attributes %s to the resolved session actor", async (operation) => {
    const app = Fastify({ logger: false }); const service = authorityService();
    await app.register(systemAuthorityRoutes, { service: service as never, sessionAuthenticator: authenticator,
      adminApiKeyFallbackEnabled: false, actorResolver: { resolveTrustedActor: async () => actor,
        resolveActor: async () => actor } });
    const response = await app.inject({ method: "POST", url: `/${operation}`,
      payload: { user_id: 8, reason: "handover" } });
    expect(response.statusCode).toBe(200);
    expect(service[operation]).toHaveBeenCalledWith(8, "handover", 7);
    await app.close();
  });

  it("prevents the legacy user route from bypassing session actor enforcement", async () => {
    const app = Fastify({ logger: false }); const updateLegacyAccess = vi.fn();
    const repository = { findById: vi.fn(), findAll: vi.fn(), updateUser: vi.fn() };
    await app.register(usersRoutes, { repository: repository as never,
      accessService: { updateLegacyAccess } as never, adminApiKey: "a".repeat(32), adminApiKeyFallbackEnabled: true,
      actorResolver: { resolveTrustedActor: async () => actor } });
    const response = await app.inject({ method: "PATCH", url: "/1", headers: { "x-admin-api-key": "a".repeat(32) },
      payload: { active: false } });
    expect(response.statusCode).toBe(401); expect(updateLegacyAccess).not.toHaveBeenCalled();
    await app.close();
  });

  it("prevents the shared API key from changing normalized user access", async () => {
    const app = Fastify({ logger: false }); const updateAccess = vi.fn();
    const service = { catalogs: vi.fn(), list: vi.fn(), get: vi.fn(), updateAccess };
    await app.register(adminUserManagementRoutes, { service: service as never,
      adminApiKey: "a".repeat(32), adminApiKeyFallbackEnabled: true,
      actorResolver: { resolveTrustedActor: async () => actor } });
    const response = await app.inject({ method: "PATCH", url: "/1/access",
      headers: { "x-admin-api-key": "a".repeat(32) }, payload: { active: false } });
    expect(response.statusCode).toBe(401); expect(updateAccess).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails closed as session-required when the legacy route has no guarded access service", async () => {
    const app = Fastify({ logger: false }); const updateUser = vi.fn();
    await app.register(usersRoutes, { repository: { findById: vi.fn(), findAll: vi.fn(), updateUser } as never,
      adminApiKey: "a".repeat(32), adminApiKeyFallbackEnabled: true });
    const response = await app.inject({ method: "PATCH", url: "/1", headers: { "x-admin-api-key": "a".repeat(32) },
      payload: { active: false } });
    expect(response.statusCode).toBe(401); expect(updateUser).not.toHaveBeenCalled();
    await app.close();
  });
});
