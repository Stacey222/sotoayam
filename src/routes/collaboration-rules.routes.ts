import { defineAdminRoutes } from "../auth/admin-authorization.js";
import { AppError } from "../errors.js";
import type { CollaborationRuleManagementService } from "../services/collaboration-rule-management.service.js";
import { parsePositiveId } from "../validation.js";
import { resolveAdminActor, type TaskActorResolver } from "../services/task-actor.service.js";
import type { FastifyRequest } from "fastify";

export interface CollaborationRulesRoutesOptions { service: CollaborationRuleManagementService; actorResolver?: TaskActorResolver; adminApiKey?: string }

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  return value as Record<string, unknown>;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new AppError(400, "VALIDATION_ERROR", `${field} must be a boolean`);
  return value;
}

export const collaborationRulesRoutes = defineAdminRoutes<CollaborationRulesRoutesOptions>(async (app, options) => {
  const actorId = async (request: FastifyRequest) => {
    if (request.adminPrincipal?.kind !== "session") return undefined;
    if (!options.actorResolver) throw new AppError(503, "COLLABORATION_ADMIN_UNAVAILABLE", "Administrator actor resolution is unavailable");
    return (await resolveAdminActor(options.actorResolver, request.adminPrincipal)).id;
  };
  app.get("/", async (request) => ({ success: true, data: await options.service.list(await actorId(request)) }));
  app.post("/", async (request, reply) => {
    const value = body(request.body);
    if (Object.keys(value).some((key) => !["source_division_id", "target_division_id", "task_scope", "allowed", "requires_approval"].includes(key))) {
      throw new AppError(400, "VALIDATION_ERROR", "Unsupported collaboration rule field");
    }
    const sourceDivisionId = parsePositiveId(String(value.source_division_id));
    const targetDivisionId = parsePositiveId(String(value.target_division_id));
    if (value.task_scope !== undefined && value.task_scope !== "ALL") throw new AppError(400, "VALIDATION_ERROR", "task_scope must be ALL");
    const data = await options.service.create({ sourceDivisionId, targetDivisionId, taskScope: "ALL",
      allowed: boolean(value.allowed, "allowed"), requiresApproval: boolean(value.requires_approval, "requires_approval") }, await actorId(request));
    return reply.status(201).send({ success: true, data });
  });
  app.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const value = body(request.body);
    if (Object.keys(value).length === 0 || Object.keys(value).some((key) => !["allowed", "requires_approval", "active"].includes(key))) {
      throw new AppError(400, "VALIDATION_ERROR", "Provide only supported collaboration rule changes");
    }
    return { success: true, data: await options.service.update(parsePositiveId(request.params.id), {
      allowed: value.allowed === undefined ? undefined : boolean(value.allowed, "allowed"),
      requiresApproval: value.requires_approval === undefined ? undefined : boolean(value.requires_approval, "requires_approval"),
      active: value.active === undefined ? undefined : boolean(value.active, "active"),
    }, await actorId(request)) };
  });
  app.delete<{ Params: { id: string } }>("/:id", async (request) => ({
    success: true, data: await options.service.deactivate(parsePositiveId(request.params.id), await actorId(request)),
  }));
});
