import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { secureEqual } from "../security.js";
import type { UserManagementService } from "../services/user-management.service.js";
import type { UserManagementStatus } from "../user-management/types.js";
import { parsePositiveId } from "../validation.js";

export interface AdminUserManagementRoutesOptions {
  service: UserManagementService;
  adminApiKey?: string;
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

export async function adminUserManagementRoutes(app: FastifyInstance, options: AdminUserManagementRoutesOptions): Promise<void> {
  app.addHook("preHandler", async (request: FastifyRequest, _reply: FastifyReply) => {
    if (options.adminApiKey && !secureEqual(request.headers["x-admin-api-key"] as string | undefined, options.adminApiKey)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid or missing admin API key");
    }
  });

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
}
