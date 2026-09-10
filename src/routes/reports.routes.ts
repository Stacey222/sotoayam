import { defineAdminRoutes } from "../auth/admin-authorization.js";
import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";
import { AppError } from "../errors.js";
import { parseReportWindow } from "../reporting/time-window.js";
import type { ReportDrillDown } from "../reporting/types.js";
import type { TaskStatusReportFilters } from "../reporting/types.js";
import { resolveAdminActor, type OwnerActorResolver, type TaskActorResolver } from "../services/task-actor.service.js";
import type { ReportingService } from "../services/reporting.service.js";
import { TASK_STATUSES, type TaskStatus } from "../tasks/types.js";

export interface ReportsRoutesOptions { service: ReportingService; actorResolver: OwnerActorResolver; adminActorResolver?: TaskActorResolver;
  adminApiKey?: string; legacyAliasEnabled?: boolean }

function detail(query: { detail?: unknown; page?: unknown }): { kind: ReportDrillDown; page: number } | null {
  if (query.detail === undefined) return null;
  if (!(["BLOCKED", "OVERDUE", "UPCOMING"] as unknown[]).includes(query.detail)) {
    throw new AppError(400, "REPORT_DETAIL_INVALID", "Report drill-down is invalid");
  }
  const page = query.page === undefined ? 0 : Number(query.page);
  if (!Number.isSafeInteger(page) || page < 0) throw new AppError(400, "REPORT_PAGE_INVALID", "Report page is invalid");
  return { kind: query.detail as ReportDrillDown, page };
}

function filters(query: { division?: unknown; task_category?: unknown; statuses?: unknown }): TaskStatusReportFilters {
  const result: TaskStatusReportFilters = {};
  if (query.division !== undefined) {
    const division = String(query.division).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(division)) throw new AppError(400, "REPORT_FILTER_INVALID", "Report division is invalid");
    result.division = division;
  }
  if (query.task_category !== undefined) {
    const category = String(query.task_category).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,49}$/.test(category)) throw new AppError(400, "REPORT_FILTER_INVALID", "Report category is invalid");
    result.taskCategory = category;
  }
  if (query.statuses !== undefined) {
    const statuses = String(query.statuses).split(",").map((item) => item.trim().toUpperCase());
    if (statuses.length === 0 || statuses.some((item) => !TASK_STATUSES.includes(item as TaskStatus))) {
      throw new AppError(400, "REPORT_FILTER_INVALID", "Report statuses are invalid");
    }
    result.statuses = [...new Set(statuses)] as TaskStatus[];
  }
  return result;
}

export const reportsRoutes = defineAdminRoutes<ReportsRoutesOptions>(async (app, options) => {
  app.addHook("preHandler", async (request) => {
    if (request.adminPrincipal?.kind !== "session") return;
    if (!options.adminActorResolver) throw new AppError(503, "REPORT_ADMIN_UNAVAILABLE", "Administrator actor resolution is unavailable");
    const admin = await resolveAdminActor(options.adminActorResolver, request.adminPrincipal);
    if (!hasSystemAdminCapability(admin)) throw new AppError(403, "REPORT_FORBIDDEN", "Active SYSTEM_ADMIN authority is required");
  });
  app.get("/task-status", { config: { rateLimit: "admin-expensive" } }, async (request) => {
    const query = request.query as { window?: unknown; detail?: unknown; page?: unknown; division?: unknown; task_category?: unknown; statuses?: unknown };
    const actor = await options.actorResolver.resolveOwnerActor();
    const window = parseReportWindow(query.window);
    const selected = filters(query);
    const selectedDetail = detail(query);
    return { success: true, data: selectedDetail
      ? await options.service.taskStatusDrillDown(actor, selected, window, selectedDetail.kind, selectedDetail.page)
      : await options.service.taskStatus(actor, selected, window) };
  });

  if (options.legacyAliasEnabled !== false) app.get("/content-creator/affiliate-task-status",
    { config: { rateLimit: "admin-expensive" } }, async (request) => {
    const query = request.query as { window?: unknown; detail?: unknown; page?: unknown };
    const actor = await options.actorResolver.resolveOwnerActor();
    const window = parseReportWindow(query.window);
    const selectedDetail = detail(query);
    if (selectedDetail) return { success: true, data: await options.service.drillDown(actor, window, selectedDetail.kind, selectedDetail.page) };
    return { success: true, data: await options.service.affiliateTaskStatus(actor, window) };
    });
}, { unauthorizedMessage: "Invalid or missing report API key" });
