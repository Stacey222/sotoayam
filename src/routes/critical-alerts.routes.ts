import { defineAdminRoutes } from "../auth/admin-authorization.js";
import { AppError } from "../errors.js";
import { resolveAdminActor, type OwnerActorResolver, type TaskActorResolver } from "../services/task-actor.service.js";
import type { CriticalAlertService } from "../services/critical-alert.service.js";
import type { CriticalAlertEvaluatorService } from "../services/critical-alert-evaluator.service.js";
import type { PersistedAlertSeverity } from "../alerts/types.js";
import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";

export const criticalAlertsRoutes = defineAdminRoutes<{ service: CriticalAlertService; actorResolver: OwnerActorResolver;
  adminActorResolver?: TaskActorResolver; adminApiKey?: string }>(async (app, options) => {
  app.addHook("preHandler", async (request) => {
    if (request.adminPrincipal?.kind !== "session") return;
    if (!options.adminActorResolver) throw new AppError(503, "ALERT_ADMIN_UNAVAILABLE", "Administrator actor resolution is unavailable");
    const admin = await resolveAdminActor(options.adminActorResolver, request.adminPrincipal);
    if (!hasSystemAdminCapability(admin)) throw new AppError(403, "ALERT_FORBIDDEN", "Active SYSTEM_ADMIN authority is required");
  });
  app.get("/", async (request) => {
    const raw = (request.query as { severity?: unknown }).severity;
    if (raw !== undefined && !["WARNING", "HIGH", "CRITICAL"].includes(String(raw))) throw new AppError(400, "ALERT_SEVERITY_INVALID", "Alert severity filter is invalid");
    const actor = await options.actorResolver.resolveOwnerActor();
    return { success: true, data: await options.service.list(actor, raw as PersistedAlertSeverity | undefined) };
  });
  app.get("/automation-status", async () => ({ success: true, data: await options.service.automationStatus(await options.actorResolver.resolveOwnerActor()) }));
  app.get("/:id", async (request) => ({ success: true, data: await options.service.get(await options.actorResolver.resolveOwnerActor(), positiveId((request.params as { id: string }).id)) }));
  app.post("/:id/acknowledge", async (request) => ({ success: true, data: await options.service.acknowledge(await options.actorResolver.resolveOwnerActor(), positiveId((request.params as { id: string }).id)) }));
}, { unauthorizedMessage: "Invalid or missing alert API key" });

export const adminCriticalAlertRoutes = defineAdminRoutes<{ evaluator: CriticalAlertEvaluatorService; actorResolver: TaskActorResolver; adminApiKey?: string }>(async (app, options) => {
  app.addHook("preHandler", async (request) => {
    const actor = await resolveAdminActor(options.actorResolver, request.adminPrincipal);
    if (!hasSystemAdminCapability(actor)) throw new AppError(403, "CRITICAL_ALERT_OPERATIONS_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
  });
  app.post("/evaluate", async (request) => {
    if ((request.query as { dry_run?: unknown }).dry_run !== "true") throw new AppError(400, "DRY_RUN_REQUIRED", "Operational evaluation requires dry_run=true");
    const result = await options.evaluator.evaluate({ dryRun: true });
    return { success: true, data: { dry_run: true, candidates: result.candidates, observations: result.observations.map((item) => ({ type: item.alertType, severity: item.severity, summary: item.summary })) } };
  });
});

function positiveId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, "VALIDATION_ERROR", "Alert id must be a positive integer");
  return id;
}
