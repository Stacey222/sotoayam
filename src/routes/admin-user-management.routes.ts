import type { FastifyRequest } from "fastify";
import { defineAdminRoutes, requireSessionPrincipal, type AdminAuthorizedRouteOptions } from "../auth/admin-authorization.js";
import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";
import { AppError } from "../errors.js";
import type { UserManagementService } from "../services/user-management.service.js";
import { resolveAdminActor, type TaskActorResolver } from "../services/task-actor.service.js";
import type { UserManagementStatus } from "../user-management/types.js";
import { parsePositiveId } from "../validation.js";

export interface AdminUserManagementRoutesOptions extends AdminAuthorizedRouteOptions {
  service: UserManagementService;
  actorResolver?: TaskActorResolver;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  return value as Record<string, unknown>;
}
function exactFields(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new AppError(400, "VALIDATION_ERROR", `Field is not allowed: ${unknown}`);
}
function nullableId(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new AppError(400, "VALIDATION_ERROR", `${field} must be a positive integer or null`);
  return value;
}
function requiredId(value: unknown, field: string): number {
  const id = nullableId(value, field);
  if (id === null) throw new AppError(400, "VALIDATION_ERROR", `${field} must be a positive integer`);
  return id;
}
function strictBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AppError(400, "VALIDATION_ERROR", `${field} must be true or false`);
}

export const adminUserManagementRoutes = defineAdminRoutes<AdminUserManagementRoutesOptions>(async (app, options) => {
  const actor = async (request: FastifyRequest) => {
    const principal = requireSessionPrincipal(request);
    if (!options.actorResolver) throw new AppError(503, "USER_MANAGEMENT_UNAVAILABLE", "User management actor resolution is unavailable");
    const resolved = await resolveAdminActor(options.actorResolver, principal);
    if (!hasSystemAdminCapability(resolved)) throw new AppError(403, "USER_ACCESS_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
    return resolved;
  };

  app.get("/catalogs", async (request) => { await actor(request); return { success: true, data: await options.service.catalogs() }; });
  app.get("/authority-summary", async (request) => { const admin = await actor(request); return { success: true, data: await options.service.authoritySummary(admin.id) }; });
  app.get("/", async (request) => {
    const admin = await actor(request); const query = request.query as Record<string, unknown>;
    exactFields(query, ["q", "status", "division_id", "system_admin", "has_login", "limit", "cursor"]);
    const q = query.q === undefined ? undefined : String(query.q).trim();
    if (q !== undefined && (q.length < 1 || q.length > 120)) throw new AppError(400, "VALIDATION_ERROR", "q must contain 1-120 characters");
    const status = query.status === undefined ? undefined : String(query.status);
    if (status !== undefined && !["pending", "active", "inactive"].includes(status)) throw new AppError(400, "VALIDATION_ERROR", "Invalid status filter");
    const divisionId = query.division_id === undefined ? undefined : parsePositiveId(String(query.division_id));
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "VALIDATION_ERROR", "limit must be an integer from 1 to 100");
    if (query.cursor !== undefined && typeof query.cursor !== "string") throw new AppError(400, "VALIDATION_ERROR", "cursor must be a string");
    const page = await options.service.listPage({ q, status: status as UserManagementStatus | undefined, division_id: divisionId,
      system_admin: strictBoolean(query.system_admin, "system_admin"), has_login: strictBoolean(query.has_login, "has_login"),
      limit, cursor: query.cursor as string | undefined }, admin.id);
    return { success: true, data: page.data, pagination: { next_cursor: page.nextCursor } };
  });
  app.post("/", async (request, reply) => {
    const admin = await actor(request); const body = record(request.body);
    exactFields(body, ["display_name", "email", "division_id", "role_id", "grant_system_admin", "reason"]);
    if (typeof body.grant_system_admin !== "boolean") throw new AppError(400, "VALIDATION_ERROR", "grant_system_admin must be boolean");
    const created = await options.service.createAdministrator({ displayName: body.display_name, email: body.email,
      divisionId: requiredId(body.division_id, "division_id"), roleId: requiredId(body.role_id, "role_id"),
      grantSystemAdmin: body.grant_system_admin, reason: body.reason }, admin.id);
    reply.header("Cache-Control", "no-store");
    request.log.info({ userId: created.user.id, actorUserId: admin.id }, "Administrator account created");
    return { success: true, data: { user: created.user, temporary_password: created.temporaryPassword } };
  });
  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    const admin = await actor(request); return { success: true, data: await options.service.getDto(parsePositiveId(request.params.id), admin.id) };
  });
  app.patch<{ Params: { id: string } }>("/:id/profile", async (request) => {
    const admin = await actor(request); const body = record(request.body); exactFields(body, ["display_name"]);
    if (Object.keys(body).length !== 1) throw new AppError(400, "VALIDATION_ERROR", "display_name is required");
    const data = await options.service.updateProfile(parsePositiveId(request.params.id), body.display_name, admin.id);
    request.log.info({ userId: data.id, actorUserId: admin.id }, "Administrator profile updated");
    return { success: true, data: await options.service.getDto(data.id, admin.id) };
  });
  app.patch<{ Params: { id: string } }>("/:id/access", async (request) => {
    const admin = await actor(request); const body = record(request.body);
    exactFields(body, ["division_id", "role_id", "active", "confirm", "reason"]);
    if (!["division_id", "role_id", "active"].some((field) => body[field] !== undefined)) throw new AppError(400, "VALIDATION_ERROR", "At least one access field is required");
    if (body.active !== undefined && typeof body.active !== "boolean") throw new AppError(400, "VALIDATION_ERROR", "active must be a boolean");
    if (body.confirm !== undefined && typeof body.confirm !== "boolean") throw new AppError(400, "VALIDATION_ERROR", "confirm must be a boolean");
    const current = await options.service.get(parsePositiveId(request.params.id));
    const data = await options.service.updateAccess(current.id, {
      division_id: body.division_id === undefined ? current.division?.id ?? null : nullableId(body.division_id, "division_id"),
      role_id: body.role_id === undefined ? current.role?.id ?? null : nullableId(body.role_id, "role_id"),
      active: body.active === undefined ? current.active : body.active,
    }, "admin_user_management_api", admin.id, { confirm: body.confirm, reason: body.reason });
    request.log.info({ userId: current.id, actorUserId: admin.id }, "Normalized user access updated");
    return { success: true, data: await options.service.getDto(data.id, admin.id) };
  });
  app.post<{ Params: { id: string } }>("/:id/login", async (request, reply) => {
    const admin = await actor(request); const body = record(request.body); exactFields(body, ["email", "reason"]);
    const result = await options.service.grantLogin(parsePositiveId(request.params.id), { email: body.email, reason: body.reason }, admin.id);
    reply.header("Cache-Control", "no-store");
    request.log.info({ userId: result.user.id, actorUserId: admin.id }, "Administrator login granted");
    return { success: true, data: { user: result.user, temporary_password: result.temporaryPassword } };
  });
  app.post<{ Params: { id: string } }>("/:id/system-admin", async (request) => {
    const admin = await actor(request); const body = record(request.body); exactFields(body, ["reason"]);
    return { success: true, data: await options.service.grantSystemAdmin(parsePositiveId(request.params.id), body.reason, admin.id) };
  });
  app.delete<{ Params: { id: string } }>("/:id/system-admin", async (request) => {
    const admin = await actor(request); const body = record(request.body); exactFields(body, ["reason", "confirm"]);
    if (typeof body.confirm !== "boolean") throw new AppError(400, "VALIDATION_ERROR", "confirm must be boolean");
    return { success: true, data: await options.service.revokeSystemAdmin(parsePositiveId(request.params.id), body.reason, body.confirm, admin.id) };
  });
  app.patch<{ Params: { id: string } }>("/:id/business-user-code", async (request) => {
    const admin = await actor(request); const value = record(request.body); exactFields(value, ["business_user_code", "confirm_change"]);
    if (!(value.business_user_code === null || typeof value.business_user_code === "string") || typeof value.confirm_change !== "boolean") {
      throw new AppError(400, "VALIDATION_ERROR", "business_user_code and confirm_change are required");
    }
    const data = await options.service.updateBusinessUserCode(parsePositiveId(request.params.id), {
      business_user_code: value.business_user_code, confirm_change: value.confirm_change,
    }, "admin_user_management_api", admin.id);
    request.log.info({ userId: data.id, actorUserId: admin.id }, "Business user code updated");
    return { success: true, data: await options.service.getDto(data.id, admin.id) };
  });
});
