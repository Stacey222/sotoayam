import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { secureEqual } from "../security.js";
import type { TaskActorResolver } from "../services/task-actor.service.js";
import type { NotificationOperationsService } from "../services/notification-operations.service.js";

export interface AdminNotificationsRoutesOptions {
  service: NotificationOperationsService; actorResolver: TaskActorResolver; adminApiKey?: string;
}

export async function adminNotificationsRoutes(app: FastifyInstance, options: AdminNotificationsRoutesOptions): Promise<void> {
  app.addHook("preHandler", async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!options.adminApiKey || !secureEqual(request.headers["x-admin-api-key"] as string | undefined, options.adminApiKey)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid or missing admin API key");
    }
    const actor = await options.actorResolver.resolveTrustedActor();
    if (!actor.active || actor.divisionId === null || actor.divisionCode !== "IT" || actor.roleId === null) {
      throw new AppError(403, "NOTIFICATION_OPERATIONS_FORBIDDEN", "Active IT SYSTEM_ADMIN authority is required");
    }
  });
  app.get("/status", async () => ({ success: true, data: await options.service.status() }));
  app.get("/recent", async (request) => {
    const raw = (request.query as { limit?: unknown }).limit;
    const limit = raw === undefined ? 20 : Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new AppError(400, "VALIDATION_ERROR", "limit must be between 1 and 50");
    return { success: true, data: await options.service.recent(limit) };
  });
  app.post("/evaluate", async (request) => {
    const dryRun = (request.query as { dry_run?: unknown }).dry_run;
    if (dryRun !== "true") throw new AppError(400, "DRY_RUN_REQUIRED", "Operational evaluation requires dry_run=true");
    return { success: true, data: await options.service.dryRun() };
  });
}
