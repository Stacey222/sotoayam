import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { secureEqual } from "../security.js";
import type { IntegrationAdministrationService } from "../services/integration-administration.service.js";
import { parsePositiveId } from "../validation.js";

export interface IntegrationAdministrationRoutesOptions { service: IntegrationAdministrationService; adminApiKey?: string }
const body = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  return value as Record<string, unknown>;
};

export async function integrationAdministrationRoutes(app: FastifyInstance, options: IntegrationAdministrationRoutesOptions) {
  app.addHook("preHandler", async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!options.adminApiKey || !secureEqual(request.headers["x-admin-api-key"] as string | undefined, options.adminApiKey)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid or missing admin API key");
    }
  });
  app.get("/", async () => ({ success: true, data: await options.service.list() }));
  app.post("/", async (request, reply) => {
    const value = body(request.body);
    if (Object.keys(value).some((key) => !["code", "name", "source", "requesting_division_id"].includes(key))
      || typeof value.code !== "string" || typeof value.name !== "string"
      || !["AUTOMATION", "ERP"].includes(String(value.source))
      || typeof value.requesting_division_id !== "number" || !Number.isSafeInteger(value.requesting_division_id) || value.requesting_division_id < 1) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid integration identity payload");
    }
    const data = await options.service.create({ code: value.code, name: value.name, source: value.source as "AUTOMATION" | "ERP", requestingDivisionId: value.requesting_division_id });
    return reply.status(201).send({ success: true, data });
  });
  app.patch<{ Params: { id: string } }>("/:id/active", async (request) => {
    const value = body(request.body);
    if (Object.keys(value).length !== 1 || typeof value.active !== "boolean") throw new AppError(400, "VALIDATION_ERROR", "active must be the only field and must be boolean");
    return { success: true, data: await options.service.setActive(parsePositiveId(request.params.id), value.active) };
  });
  app.get<{ Params: { id: string } }>("/:id/capabilities", async (request) => ({
    success: true, data: await options.service.listCapabilities(parsePositiveId(request.params.id)),
  }));
  app.put<{ Params: { id: string; capability: string } }>("/:id/capabilities/:capability", async (request) => ({
    success: true, data: await options.service.grantCapability(parsePositiveId(request.params.id), request.params.capability),
  }));
  app.delete<{ Params: { id: string; capability: string } }>("/:id/capabilities/:capability", async (request) => ({
    success: true, data: await options.service.revokeCapability(parsePositiveId(request.params.id), request.params.capability),
  }));
}
