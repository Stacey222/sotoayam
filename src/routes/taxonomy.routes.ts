import { defineAdminRoutes } from "../auth/admin-authorization.js";
import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";
import { AppError } from "../errors.js";
import type { TaskCategoryService } from "../services/task-category.service.js";
import { resolveAdminActor, type TaskActorResolver } from "../services/task-actor.service.js";
import type { FastifyRequest } from "fastify";
import type { TaxonomyManagementService } from "../services/taxonomy-management.service.js";
import { parsePositiveId } from "../validation.js";

export interface TaxonomyRoutesOptions {
  service: TaxonomyManagementService;
  categories: TaskCategoryService;
  actorResolver: TaskActorResolver;
  adminApiKey?: string;
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[], codeError = "VALIDATION_ERROR"): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new AppError(400, unknown === "code" ? codeError : "VALIDATION_ERROR", `Field is not allowed: ${unknown}`);
}

export const taxonomyRoutes = defineAdminRoutes<TaxonomyRoutesOptions>(async (app, options) => {
  const actor = async (request: FastifyRequest) => {
    const resolved = await resolveAdminActor(options.actorResolver, request.adminPrincipal);
    if (!hasSystemAdminCapability(resolved)) throw new AppError(403, "TAXONOMY_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
    return resolved;
  };

  app.get("/divisions", async (request) => {
    const active = (request.query as { active?: unknown }).active;
    if (active !== undefined && active !== "true" && active !== "false") throw new AppError(400, "VALIDATION_ERROR", "active must be true or false");
    await actor(request);
    return { success: true, data: await options.service.listDivisions(active === "true") };
  });
  app.post("/divisions", async (request, reply) => {
    const value = body(request.body); fields(value, ["code", "name"]);
    if (typeof value.code !== "string" || typeof value.name !== "string") throw new AppError(400, "VALIDATION_ERROR", "code and name are required");
    return reply.status(201).send({ success: true, data: await options.service.createDivision({ code: value.code, name: value.name }, await actor(request)) });
  });
  app.patch<{ Params: { id: string } }>("/divisions/:id", async (request) => {
    const value = body(request.body); fields(value, ["name", "active"], "DIVISION_CODE_IMMUTABLE");
    if (Object.keys(value).length === 0 || (value.name !== undefined && typeof value.name !== "string")
      || (value.active !== undefined && typeof value.active !== "boolean")) throw new AppError(400, "VALIDATION_ERROR", "Provide a valid name and/or active value");
    return { success: true, data: await options.service.updateDivision(parsePositiveId(request.params.id), value as { name?: string; active?: boolean }, await actor(request)) };
  });
  app.delete<{ Params: { id: string } }>("/divisions/:id", async (request) => ({
    success: true, data: await options.service.deleteDivision(parsePositiveId(request.params.id), await actor(request)),
  }));

  app.get("/roles", async (request) => { await actor(request); return { success: true, data: await options.service.listRoles() }; });
  app.patch<{ Params: { id: string } }>("/roles/:id", async (request) => {
    const value = body(request.body); fields(value, ["name"], "ROLE_RESERVED");
    if (typeof value.name !== "string" || Object.keys(value).length !== 1) throw new AppError(400, "VALIDATION_ERROR", "Only name may be changed");
    return { success: true, data: await options.service.renameRole(parsePositiveId(request.params.id), value.name, await actor(request)) };
  });

  app.get("/task-categories", async (request) => { await actor(request); return { success: true, data: await options.categories.list() }; });
  app.post("/task-categories", async (request, reply) => {
    const value = body(request.body); fields(value, ["code", "name"]);
    if (typeof value.code !== "string" || typeof value.name !== "string") throw new AppError(400, "VALIDATION_ERROR", "code and name are required");
    return reply.status(201).send({ success: true, data: await options.categories.create({ code: value.code, name: value.name }, (await actor(request)).id) });
  });
  app.patch<{ Params: { id: string } }>("/task-categories/:id", async (request) => {
    const value = body(request.body);
    if ("code" in value) throw new AppError(400, "TASK_CATEGORY_CODE_IMMUTABLE", "Task category code is immutable");
    fields(value, ["name", "active"]);
    if (Object.keys(value).length === 0 || (value.name !== undefined && typeof value.name !== "string")
      || (value.active !== undefined && typeof value.active !== "boolean")) throw new AppError(400, "VALIDATION_ERROR", "Provide a valid name and/or active value");
    return { success: true, data: await options.categories.update(parsePositiveId(request.params.id), value as { name?: string; active?: boolean }, (await actor(request)).id) };
  });
  app.delete<{ Params: { id: string } }>("/task-categories/:id", async (request) => ({
    success: true, data: await options.categories.delete(parsePositiveId(request.params.id), (await actor(request)).id),
  }));
});
