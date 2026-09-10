import { defineAdminRoutes, requireSessionPrincipal, type AdminAuthorizedRouteOptions } from "../auth/admin-authorization.js";
import { AppError } from "../errors.js";
import type { IntegrationAdministrationService } from "../services/integration-administration.service.js";
import { parsePositiveId } from "../validation.js";
import { resolveAdminActor, type TaskActorResolver } from "../services/task-actor.service.js";
import type { FastifyRequest } from "fastify";

export interface IntegrationAdministrationRoutesOptions extends AdminAuthorizedRouteOptions {
  service: IntegrationAdministrationService;
  actorResolver?: TaskActorResolver;
}
const body = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  return value as Record<string, unknown>;
};

export const integrationAdministrationRoutes = defineAdminRoutes<IntegrationAdministrationRoutesOptions>(async (app, options) => {
  const actorId = async (request: FastifyRequest) => {
    if (request.adminPrincipal?.kind !== "session") return undefined;
    if (!options.actorResolver) throw new AppError(503, "INTEGRATION_ADMIN_UNAVAILABLE", "Administrator actor resolution is unavailable");
    return (await resolveAdminActor(options.actorResolver, request.adminPrincipal)).id;
  };
  const sessionActorId = async (request: FastifyRequest) => {
    requireSessionPrincipal(request);
    if (!options.actorResolver) throw new AppError(503, "INTEGRATION_ADMIN_UNAVAILABLE", "Administrator actor resolution is unavailable");
    return (await resolveAdminActor(options.actorResolver, request.adminPrincipal)).id;
  };
  app.get("/", async (request) => ({ success: true, data: await options.service.list(await actorId(request)) }));
  app.post("/", async (request, reply) => {
    const value = body(request.body);
    if (Object.keys(value).some((key) => !["code", "name", "source", "requesting_division_id"].includes(key))
      || typeof value.code !== "string" || typeof value.name !== "string"
      || !["AUTOMATION", "ERP"].includes(String(value.source))
      || typeof value.requesting_division_id !== "number" || !Number.isSafeInteger(value.requesting_division_id) || value.requesting_division_id < 1) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid integration identity payload");
    }
    const data = await options.service.create({ code: value.code, name: value.name, source: value.source as "AUTOMATION" | "ERP", requestingDivisionId: value.requesting_division_id }, await actorId(request));
    return reply.status(201).send({ success: true, data });
  });
  app.patch<{ Params: { id: string } }>("/:id/active", async (request) => {
    const value = body(request.body);
    if (Object.keys(value).length !== 1 || typeof value.active !== "boolean") throw new AppError(400, "VALIDATION_ERROR", "active must be the only field and must be boolean");
    return { success: true, data: await options.service.setActive(parsePositiveId(request.params.id), value.active, await actorId(request)) };
  });
  app.get<{ Params: { id: string } }>("/:id/capabilities", async (request) => ({
    success: true, data: await options.service.listCapabilities(parsePositiveId(request.params.id), await actorId(request)),
  }));
  app.put<{ Params: { id: string; capability: string } }>("/:id/capabilities/:capability", async (request) => ({
    success: true, data: await options.service.grantCapability(parsePositiveId(request.params.id), request.params.capability, await actorId(request)),
  }));
  app.delete<{ Params: { id: string; capability: string } }>("/:id/capabilities/:capability", async (request) => ({
    success: true, data: await options.service.revokeCapability(parsePositiveId(request.params.id), request.params.capability, await actorId(request)),
  }));
  app.get<{ Params: { id: string } }>("/:id/credentials", async (request) => ({
    success: true, data: await options.service.listCredentials(parsePositiveId(request.params.id), await sessionActorId(request)),
  }));
  app.post<{ Params: { id: string } }>("/:id/credentials", async (request, reply) => {
    const value = body(request.body);
    if (Object.keys(value).some((key) => !["label", "expires_at", "rotation_of_credential_id"].includes(key))) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid credential creation payload");
    }
    const created = await options.service.createCredential(parsePositiveId(request.params.id), {
      label: value.label, expiresAt: value.expires_at, rotationOfCredentialId: value.rotation_of_credential_id,
    }, await sessionActorId(request));
    reply.header("Cache-Control", "no-store");
    return reply.status(201).send({ success: true, data: { id: created.id, selector: created.selector,
      credential: created.credential, expires_at: created.expires_at } });
  });
  app.post<{ Params: { id: string; credentialId: string } }>("/:id/credentials/:credentialId/revoke", async (request) => {
    const value = body(request.body ?? {});
    if (Object.keys(value).some((key) => !["reason", "grace_seconds"].includes(key))) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid credential revocation payload");
    }
    return { success: true, data: await options.service.revokeCredential(parsePositiveId(request.params.id),
      parsePositiveId(request.params.credentialId), { reason: value.reason, graceSeconds: value.grace_seconds },
      await sessionActorId(request)) };
  });
});
