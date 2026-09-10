import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { defineAdminRoutes } from "../../src/auth/admin-authorization.js";
import { generateIntegrationCredential, type IntegrationAuthenticationStatus } from "../../src/auth/integration-credential.js";
import { AppError } from "../../src/errors.js";
import type { IntegrationCredentialRepository } from "../../src/repositories/integration-credential.repository.js";
import { internalTaskIngestionRoutes } from "../../src/routes/task-ingestion.routes.js";
import { notificationRoutes } from "../../src/routes/notifications.routes.js";
import { IntegrationCredentialService } from "../../src/services/integration-credential.service.js";

const generated = generateIntegrationCredential((size) => Buffer.alloc(size, size === 10 ? 1 : 2));
const integration = { integrationId: 7, credentialId: 11, code: "ERP_SYNC", source: "ERP" as const,
  requestingDivisionId: 19 };

function repository(status: IntegrationAuthenticationStatus = "OK"): IntegrationCredentialRepository {
  return { authenticate: vi.fn().mockResolvedValue({ status, principal: status === "OK" ? integration : null }),
    create: vi.fn(), list: vi.fn(), revoke: vi.fn(), revokeAll: vi.fn() };
}

async function taskApp(repo: IntegrationCredentialRepository) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR", "Unexpected");
    return reply.status(known.statusCode).send({ success: false, error: { code: known.code, message: known.message } });
  });
  const ingestAutomation = vi.fn().mockResolvedValue({ accepted: true });
  await app.register(internalTaskIngestionRoutes, { service: { ingestAutomation } as never,
    integrations: { findActiveByCode: vi.fn(), hasActiveCapability: vi.fn() }, internalApiKey: "legacy-key",
    internalApiKeyFallbackEnabled: false, credentials: new IntegrationCredentialService(repo) });
  return { app, ingestAutomation };
}

const request = (app: Awaited<ReturnType<typeof taskApp>>["app"], headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/tasks", headers,
    payload: { title: "Task", owner_division: "OPERATIONS", external_reference: "ext-1" } });

describe("P1-04 integration credential authentication", () => {
  it("P4-01 authenticates a valid credential and resolves its owning integration", async () => {
    const repo = repository(); const { app, ingestAutomation } = await taskApp(repo);
    try {
      expect((await request(app, { "x-integration-key": generated.credential })).statusCode).toBe(200);
      expect(ingestAutomation.mock.calls[0]?.[0]).toMatchObject({ id: 7, code: "ERP_SYNC", source: "ERP",
        requesting_division_id: 19 });
      expect(repo.authenticate).toHaveBeenCalledWith(generated.selector, generated.secretHash, "TASK_CREATE");
    } finally { await app.close(); }
  });

  it.each([
    ["absent", undefined], ["wrong prefix", `wrong_${generated.selector}_${generated.secret}`],
    ["wrong selector length", `soto_ik_short_${generated.secret}`],
    ["wrong selector charset", `soto_ik_${"u".repeat(16)}_${generated.secret}`],
    ["wrong secret length", `soto_ik_${generated.selector}_short`],
    ["wrong secret charset", `soto_ik_${generated.selector}_${"!".repeat(43)}`],
  ])("P4-02 rejects %s shape without a database call", async (_label, raw) => {
    const repo = repository(); const { app } = await taskApp(repo);
    try {
      const response = await request(app, raw ? { "x-integration-key": raw } : {});
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ success: false, error: { code: "INTEGRATION_UNAUTHORIZED",
        message: "Invalid or missing integration credential" } });
      expect(repo.authenticate).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("P4-03 rejects a valid selector with a wrong secret", async () => {
    const repo = repository("BAD_SECRET"); const { app } = await taskApp(repo);
    try { expect((await request(app, { "x-integration-key": generated.credential })).statusCode).toBe(401);
      expect(repo.authenticate).toHaveBeenCalledOnce(); } finally { await app.close(); }
  });

  it("P4-04 makes unknown, bad, revoked, expired, and inactive failures byte-identical", async () => {
    const bodies: string[] = [];
    for (const status of ["UNKNOWN", "BAD_SECRET", "REVOKED", "EXPIRED", "INTEGRATION_INACTIVE"] as const) {
      const { app } = await taskApp(repository(status));
      try { const response = await request(app, { "x-integration-key": generated.credential });
        expect(response.statusCode).toBe(401); bodies.push(response.body); } finally { await app.close(); }
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("P4-05 refuses cross-integration claims and uses the credential division", async () => {
    const { app, ingestAutomation } = await taskApp(repository());
    try {
      expect((await request(app, { "x-integration-key": generated.credential, "x-integration-code": "OTHER" })).statusCode).toBe(401);
      expect(ingestAutomation).not.toHaveBeenCalled();
      expect((await request(app, { "x-integration-key": generated.credential })).statusCode).toBe(200);
      expect(ingestAutomation.mock.calls[0]?.[0].requesting_division_id).toBe(19);
    } finally { await app.close(); }
  });

  it("P4-06 treats integration code only as an optional consistency assertion", async () => {
    const { app } = await taskApp(repository());
    try {
      expect((await request(app, { "x-integration-key": generated.credential, "x-integration-code": "ERP_SYNC" })).statusCode).toBe(200);
      expect((await request(app, { "x-integration-key": generated.credential })).statusCode).toBe(200);
      expect((await request(app, { "x-integration-code": "ERP_SYNC" })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("P4-07 reports missing capability as a distinct 403", async () => {
    const { app } = await taskApp(repository("CAPABILITY_MISSING"));
    try { const response = await request(app, { "x-integration-key": generated.credential });
      expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe("INTEGRATION_CAPABILITY_REQUIRED");
    } finally { await app.close(); }
  });

  it("P4-21 never accepts an integration credential on an admin scope", async () => {
    const app = Fastify({ logger: false });
    await app.register(defineAdminRoutes(async (scope) => { scope.get("/", async () => ({ ok: true })); }),
      { adminApiKeyFallbackEnabled: false });
    try { expect((await app.inject({ method: "GET", url: "/", headers: {
      "x-integration-key": generated.credential } })).statusCode).toBe(401); } finally { await app.close(); }
  });

  it("P4-31 attributes credential notification intake without changing its event contract", async () => {
    const app = Fastify({ logger: false }); const send = vi.fn().mockResolvedValue({ success: true });
    await app.register(notificationRoutes, { notificationService: { send }, internalApiKey: "legacy",
      internalApiKeyFallbackEnabled: true, credentials: new IntegrationCredentialService(repository()) });
    const payload = { type: "SYSTEM_ERROR", message: "Test", event_id: "event-1" };
    try {
      expect((await app.inject({ method: "POST", url: "/send", headers: {
        "x-integration-key": generated.credential }, payload })).statusCode).toBe(200);
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ event_id: "event-1" }), 7);
      expect((await app.inject({ method: "POST", url: "/send", headers: {
        "x-internal-api-key": "legacy" }, payload: { ...payload, event_id: "event-2" } })).statusCode).toBe(200);
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ event_id: "event-2" }), null);
    } finally { await app.close(); }
  });
});
