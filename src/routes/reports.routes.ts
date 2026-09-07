import { defineAdminRoutes } from "../auth/admin-authorization.js";
import { AppError } from "../errors.js";
import { parseReportWindow } from "../reporting/time-window.js";
import type { ReportDrillDown } from "../reporting/types.js";
import type { OwnerActorResolver } from "../services/task-actor.service.js";
import type { ReportingService } from "../services/reporting.service.js";

export interface ReportsRoutesOptions { service: ReportingService; actorResolver: OwnerActorResolver; adminApiKey?: string }

export const reportsRoutes = defineAdminRoutes<ReportsRoutesOptions>(async (app, options) => {
  app.get("/content-creator/affiliate-task-status", async (request) => {
    const query = request.query as { window?: unknown; detail?: unknown; page?: unknown };
    const actor = await options.actorResolver.resolveOwnerActor();
    const window = parseReportWindow(query.window);
    if (query.detail !== undefined) {
      if (!(["BLOCKED", "OVERDUE", "UPCOMING"] as unknown[]).includes(query.detail)) {
        throw new AppError(400, "REPORT_DETAIL_INVALID", "Report drill-down is invalid");
      }
      const page = query.page === undefined ? 0 : Number(query.page);
      if (!Number.isSafeInteger(page) || page < 0) throw new AppError(400, "REPORT_PAGE_INVALID", "Report page is invalid");
      return { success: true, data: await options.service.drillDown(actor, window, query.detail as ReportDrillDown, page) };
    }
    return { success: true, data: await options.service.affiliateTaskStatus(actor, window) };
  });
}, { unauthorizedMessage: "Invalid or missing report API key" });
