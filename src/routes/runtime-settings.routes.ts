import type { FastifyRequest } from "fastify";
import { defineAdminRoutes, requireSessionPrincipal, type AdminAuthorizedRouteOptions } from "../auth/admin-authorization.js";
import { AppError } from "../errors.js";
import type { RuntimeSettingsService } from "../services/runtime-settings.service.js";
import { resolveAdminActor, type TaskActorResolver } from "../services/task-actor.service.js";

export interface RuntimeSettingsRoutesOptions extends AdminAuthorizedRouteOptions {
  service: RuntimeSettingsService;
  actorResolver: TaskActorResolver;
}
function body(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some((key) => !(key in record))
    || Object.keys(record).some((key) => !fields.includes(key))) throw new AppError(400, "VALIDATION_ERROR", "Request body fields are invalid");
  return record;
}
function integer(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new AppError(400, "VALIDATION_ERROR", `${name} is invalid`);
  return value;
}
export const runtimeSettingsRoutes = defineAdminRoutes<RuntimeSettingsRoutesOptions>(async (app, options) => {
  const sessionActor = async (request: FastifyRequest) => {
    const principal = requireSessionPrincipal(request);
    if (!options.actorResolver.resolveSessionActor) throw new AppError(503, "RUNTIME_SETTINGS_UNAVAILABLE", "Business actor resolution is unavailable");
    return options.actorResolver.resolveSessionActor(principal);
  };
  app.get("/", async (request, reply) => {
    const actor = await sessionActor(request);
    let systemAdmin = false;
    try { await resolveAdminActor(options.actorResolver, request.adminPrincipal); systemAdmin = true; }
    catch (error) { if (!(error instanceof AppError) || error.statusCode !== 403) throw error; }
    reply.header("Cache-Control", "no-store");
    return { success: true, data: options.service.current(actor, systemAdmin) };
  });
  app.patch("/runtime", async (request, reply) => {
    const actor = await sessionActor(request);
    const value = body(request.body, ["expected_version", "business_time_zone", "reminder_scheduler_interval_seconds", "critical_alert_policy", "reason"]);
    const data = await options.service.updateRuntime(actor, { expectedVersion: integer(value.expected_version, "expected_version", 0),
      businessTimeZone: value.business_time_zone as string,
      reminderSchedulerIntervalSeconds: integer(value.reminder_scheduler_interval_seconds, "reminder_scheduler_interval_seconds", 1),
      criticalAlertPolicy: value.critical_alert_policy, reason: value.reason as string });
    request.log.info({ actorUserId: actor.id, settingsVersion: data.version,
      changedFields: ["business_time_zone", "reminder_scheduler_interval_seconds", "critical_alert_policy"] }, "Runtime settings updated");
    reply.header("Cache-Control", "no-store"); return { success: true, data };
  });
  app.patch("/business-actor", async (request, reply) => {
    requireSessionPrincipal(request);
    const actor = await resolveAdminActor(options.actorResolver, request.adminPrincipal);
    const value = body(request.body, ["expected_version", "user_id", "reason"]);
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    if (reason.length < 1 || reason.length > 500) throw new AppError(400, "VALIDATION_ERROR", "reason must contain 1-500 characters");
    const data = await options.service.setBusinessActor(actor, { expectedVersion: integer(value.expected_version, "expected_version", 0),
      userId: integer(value.user_id, "user_id", 1), reason });
    request.log.info({ actorUserId: actor.id, businessActorUserId: value.user_id, settingsVersion: data.version }, "Business actor changed");
    reply.header("Cache-Control", "no-store"); return { success: true, data };
  });
});
