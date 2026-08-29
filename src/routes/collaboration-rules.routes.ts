import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { secureEqual } from "../security.js";
import type { CollaborationRuleManagementService } from "../services/collaboration-rule-management.service.js";
import { parsePositiveId } from "../validation.js";

export interface CollaborationRulesRoutesOptions { service: CollaborationRuleManagementService; adminApiKey?: string }

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  return value as Record<string, unknown>;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new AppError(400, "VALIDATION_ERROR", `${field} must be a boolean`);
  return value;
}

export async function collaborationRulesRoutes(app: FastifyInstance, options: CollaborationRulesRoutesOptions): Promise<void> {
  app.addHook("preHandler", async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!options.adminApiKey || !secureEqual(request.headers["x-admin-api-key"] as string | undefined, options.adminApiKey)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid or missing admin API key");
    }
  });
  app.get("/", async () => ({ success: true, data: await options.service.list() }));
  app.post("/", async (request, reply) => {
    const value = body(request.body);
    if (Object.keys(value).some((key) => !["source_division_id", "target_division_id", "task_scope", "allowed", "requires_approval"].includes(key))) {
      throw new AppError(400, "VALIDATION_ERROR", "Unsupported collaboration rule field");
    }
    const sourceDivisionId = parsePositiveId(String(value.source_division_id));
    const targetDivisionId = parsePositiveId(String(value.target_division_id));
    if (value.task_scope !== undefined && value.task_scope !== "ALL") throw new AppError(400, "VALIDATION_ERROR", "task_scope must be ALL");
    const data = await options.service.create({ sourceDivisionId, targetDivisionId, taskScope: "ALL",
      allowed: boolean(value.allowed, "allowed"), requiresApproval: boolean(value.requires_approval, "requires_approval") });
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
    }) };
  });
}
