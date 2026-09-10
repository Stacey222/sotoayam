import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { defineAdminRoutes } from "../auth/admin-authorization.js";
import { AppError } from "../errors.js";
import { CSV_MAX_BYTES } from "../ingestion/csv-parser.js";
import { parseAutomationIntake } from "../ingestion/automation-validation.js";
import type { TaskSourceIntegrationsRepository } from "../repositories/task-ingestion.repository.js";
import { secureEqual } from "../security.js";
import { resolveAdminActor, type TaskActorResolver } from "../services/task-actor.service.js";
import type { TaskIngestionService } from "../services/task-ingestion.service.js";

export interface CsvImportRoutesOptions { service: TaskIngestionService; actorResolver: TaskActorResolver; adminApiKey?: string }
export interface InternalTaskRoutesOptions { service: TaskIngestionService; integrations: TaskSourceIntegrationsRepository; internalApiKey: string }

export const csvImportRoutes = defineAdminRoutes<CsvImportRoutesOptions>(async (app, options) => {
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_request, body, done) => done(null, body));
  app.post<{ Querystring: { dry_run?: string } }>("/csv", {
    bodyLimit: CSV_MAX_BYTES, config: { rateLimit: "admin-expensive" },
  }, async (request) => {
    if (typeof request.body !== "string") throw new AppError(400, "CSV_CONTENT_TYPE_REQUIRED", "Use text/csv with a UTF-8 CSV body");
    const dryRun = booleanQuery(request.query.dry_run);
    const safeLabel = importLabel(request.headers["x-import-label"]);
    const actor = await resolveAdminActor(options.actorResolver, request.adminPrincipal);
    return { success: true, data: await options.service.importCsv(actor, request.body, { dryRun, safeLabel }) };
  });
});

export async function internalTaskIngestionRoutes(app: FastifyInstance, options: InternalTaskRoutesOptions): Promise<void> {
  app.addHook("preHandler", async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!secureEqual(request.headers["x-internal-api-key"] as string | undefined, options.internalApiKey)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid or missing internal API key");
    }
  });
  app.post<{ Querystring: { dry_run?: string } }>("/tasks", { config: { rateLimit: "internal" } }, async (request) => {
    const rawCode = request.headers["x-integration-code"];
    if (typeof rawCode !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(rawCode.trim().toUpperCase())) {
      throw new AppError(401, "INTEGRATION_REQUIRED", "A valid integration identity is required");
    }
    const integration = await options.integrations.findActiveByCode(rawCode.trim().toUpperCase());
    if (!integration) throw new AppError(403, "INTEGRATION_FORBIDDEN", "Integration identity is unknown or inactive");
    request.server.rateLimitIntegrationIdentity?.(request, integration.id);
    if (!await options.integrations.hasActiveCapability(integration.id, "TASK_CREATE")) {
      throw new AppError(403, "INTEGRATION_CAPABILITY_REQUIRED", "Integration does not have TASK_CREATE capability");
    }
    return { success: true, data: await options.service.ingestAutomation(integration, parseAutomationIntake(request.body), booleanQuery(request.query.dry_run)) };
  });
}

function booleanQuery(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new AppError(400, "VALIDATION_ERROR", "dry_run must be true or false");
}

function importLabel(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new AppError(400, "INVALID_IMPORT_LABEL", "Import label is invalid");
  const label = value.trim();
  if (!label || label.length > 200 || /[\\/\u0000-\u001f]/.test(label)) {
    throw new AppError(400, "INVALID_IMPORT_LABEL", "Import label must be a safe filename or label");
  }
  return label;
}
