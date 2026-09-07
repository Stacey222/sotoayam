import { defineAdminRoutes } from "../auth/admin-authorization.js";
import { AppError } from "../errors.js";
import type { SystemAuthorityService } from "../services/system-authority.service.js";

export interface SystemAuthorityRoutesOptions { service: SystemAuthorityService; adminApiKey?: string }

function input(body: unknown): { userId: number; reason: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["user_id", "reason"].includes(key))) throw new AppError(400, "VALIDATION_ERROR", "Unsupported authority field");
  if (typeof value.user_id !== "number" || !Number.isSafeInteger(value.user_id) || value.user_id < 1) throw new AppError(400, "VALIDATION_ERROR", "user_id must be a positive integer");
  if (typeof value.reason !== "string" || value.reason.trim().length < 1 || value.reason.length > 500) throw new AppError(400, "VALIDATION_ERROR", "reason must contain 1-500 characters");
  return { userId: value.user_id, reason: value.reason.trim() };
}

export const systemAuthorityRoutes = defineAdminRoutes<SystemAuthorityRoutesOptions>(async (app, options) => {
  app.get("/status", async () => ({ success: true, data: await options.service.status() }));
  app.post("/assign", async (request) => { const value = input(request.body); return { success: true, data: await options.service.assign(value.userId, value.reason) }; });
  app.post("/revoke", async (request) => { const value = input(request.body); return { success: true, data: await options.service.revoke(value.userId, value.reason) }; });
});
