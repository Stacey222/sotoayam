import { defineAdminRoutes, requireSessionPrincipal, type AdminAuthorizedRouteOptions } from "../auth/admin-authorization.js";
import { AppError } from "../errors.js";
import { resolveAdminActor, type TaskActorResolver } from "../services/task-actor.service.js";
import type { NotificationOperationsService } from "../services/notification-operations.service.js";
import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";
import type { AdminTestNotificationService } from "../services/admin-test-notification.service.js";

export interface AdminNotificationsRoutesOptions extends AdminAuthorizedRouteOptions {
  service: NotificationOperationsService; actorResolver: TaskActorResolver;
  testService?: AdminTestNotificationService;
}

export const adminNotificationsRoutes = defineAdminRoutes<AdminNotificationsRoutesOptions>(async (app, options) => {
  app.addHook("preHandler", async (request) => {
    const actor = await resolveAdminActor(options.actorResolver, request.adminPrincipal);
    if (!hasSystemAdminCapability(actor)) {
      throw new AppError(403, "NOTIFICATION_OPERATIONS_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
    }
  });
  app.get("/status", async () => ({ success: true, data: await options.service.status() }));
  app.get("/recent", async (request) => {
    const raw = (request.query as { limit?: unknown }).limit;
    const limit = raw === undefined ? 20 : Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new AppError(400, "VALIDATION_ERROR", "limit must be between 1 and 50");
    return { success: true, data: await options.service.recent(limit) };
  });
  app.post("/evaluate", { config: { rateLimit: "admin-expensive" } }, async (request) => {
    const dryRun = (request.query as { dry_run?: unknown }).dry_run;
    if (dryRun !== "true") throw new AppError(400, "DRY_RUN_REQUIRED", "Operational evaluation requires dry_run=true");
    return { success: true, data: await options.service.dryRun() };
  });
  if (options.testService) {
    app.get("/test-recipients", async (request) => {
      requireSessionPrincipal(request);
      return { success: true, data: await options.testService!.recipients((request.query as { type?: unknown }).type) };
    });
    app.post("/test", { config: { rateLimit: "admin-expensive" } }, async (request) => {
      const principal = requireSessionPrincipal(request);
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some((key) => !["recipient_user_id", "request_id", "type"].includes(key))) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid test notification request");
      }
      const input = body as Record<string, unknown>;
      return { success: true, data: await options.testService!.send(
        input.recipient_user_id as number, input.request_id as string, principal.adminUserId, request.id, input.type) };
    });
  }
});
