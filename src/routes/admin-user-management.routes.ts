import { defineAdminRoutes } from "../auth/admin-authorization.js";
import { AppError } from "../errors.js";
import type { UserManagementService } from "../services/user-management.service.js";
import type { UserManagementStatus } from "../user-management/types.js";
import { resolveAdminActor, type TaskActorResolver } from "../services/task-actor.service.js";
import { parsePositiveId } from "../validation.js";
import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";

export interface AdminUserManagementRoutesOptions {
  service: UserManagementService;
  adminApiKey?: string;
  actorResolver?: TaskActorResolver;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  return value as Record<string, unknown>;
}

function nullableId(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new AppError(400, "VALIDATION_ERROR", `${field} must be a positive integer or null`);
  return value;
}

export const adminUserManagementRoutes = defineAdminRoutes<AdminUserManagementRoutesOptions>(async (app, options) => {
  app.get("/catalogs", async () => ({ success: true, data: await options.service.catalogs() }));
  app.get("/", async (request) => {
    const value = (request.query as { status?: unknown }).status;
    if (value !== undefined && !["pending", "active", "inactive"].includes(String(value))) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid status filter");
    }
    return { success: true, data: await options.service.list(value as UserManagementStatus | undefined) };
  });
  app.get<{ Params: { id: string } }>("/:id", async (request) => ({
    success: true, data: await options.service.get(parsePositiveId(request.params.id)),
  }));
  app.patch<{ Params: { id: string } }>("/:id/access", async (request) => {
    const body = record(request.body);
    const unknown = Object.keys(body).find((key) => !["division_id", "role_id", "active"].includes(key));
    if (unknown) throw new AppError(400, "VALIDATION_ERROR", `Field is not allowed: ${unknown}`);
    if (Object.keys(body).length === 0) throw new AppError(400, "VALIDATION_ERROR", "At least one field is required");
    const current = await options.service.get(parsePositiveId(request.params.id));
    if (body.active !== undefined && typeof body.active !== "boolean") throw new AppError(400, "VALIDATION_ERROR", "active must be a boolean");
    const data = await options.service.updateAccess(current.id, {
      division_id: body.division_id === undefined ? current.division?.id ?? null : nullableId(body.division_id, "division_id"),
      role_id: body.role_id === undefined ? current.role?.id ?? null : nullableId(body.role_id, "role_id"),
      active: body.active === undefined ? current.active : body.active,
    });
    request.log.info({ userId: current.id }, "Normalized user access updated");
    return { success: true, data };
  });
  app.patch<{ Params: { id: string } }>("/:id/business-user-code", async (request) => {
    if (!options.actorResolver) throw new AppError(503, "BUSINESS_USER_CODE_ADMIN_UNAVAILABLE", "Business user code administration is unavailable");
    const actor = await resolveAdminActor(options.actorResolver, request.adminPrincipal);
    if (!hasSystemAdminCapability(actor)) {
      throw new AppError(403, "BUSINESS_USER_CODE_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
    }
    const value = record(request.body);
    if (Object.keys(value).some((key) => !["business_user_code", "confirm_change"].includes(key))
      || !(value.business_user_code === null || typeof value.business_user_code === "string")
      || typeof value.confirm_change !== "boolean") {
      throw new AppError(400, "VALIDATION_ERROR", "business_user_code and confirm_change are required");
    }
    const data = await options.service.updateBusinessUserCode(parsePositiveId(request.params.id), {
      business_user_code: value.business_user_code,
      confirm_change: value.confirm_change,
    }, "admin_user_management_api", actor.id);
    request.log.info({ userId: data.id }, "Business user code updated");
    return { success: true, data };
  });
});
