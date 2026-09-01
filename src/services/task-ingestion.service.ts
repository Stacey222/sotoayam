import { AppError } from "../errors.js";
import { parseTaskCsv, type CsvTaskRow } from "../ingestion/csv-parser.js";
import type { TaskImportResponse, TaskImportRowResult, TaskIntakeContext, TaskIntakeRequest } from "../ingestion/types.js";
import type { AuditRepository } from "../repositories/audit.repository.js";
import type { DivisionsRepository } from "../repositories/divisions.repository.js";
import type { ImportBatchRepository, TaskSourceIntegration } from "../repositories/task-ingestion.repository.js";
import type { TaskActor, TaskCategory, TaskPriority } from "../tasks/types.js";
import { TASK_CATEGORIES, TASK_PRIORITIES } from "../tasks/types.js";
import type { TaskService } from "./task.service.js";

export class TaskIngestionService {
  constructor(
    private readonly tasks: TaskService,
    private readonly divisions: DivisionsRepository,
    private readonly batches: ImportBatchRepository,
    private readonly audit: AuditRepository,
  ) {}

  async importCsv(actor: TaskActor, csv: string, options: { dryRun: boolean; safeLabel: string | null }): Promise<TaskImportResponse> {
    if (!actor.active || actor.divisionId === null || actor.roleId === null || !actor.permissions.has("task.import")) {
      throw new AppError(403, "TASK_FORBIDDEN", "Task import permission is required");
    }
    const rows = parseTaskCsv(csv);
    const batch = await this.batches.create({
      context: "HUMAN_IMPORT", source: "CSV_IMPORT", initiated_by_user_id: actor.id,
      integration_id: null, safe_label: options.safeLabel, dry_run: options.dryRun,
    });
    const context: TaskIntakeContext = { kind: "HUMAN_IMPORT", actorUserId: actor.id, requestingDivisionId: actor.divisionId, batchId: batch.id };
    const inputs = rows.map((row) => {
      try { return this.fromCsv(row); }
      catch (error) { return error instanceof AppError ? error : new AppError(400, "VALIDATION_ERROR", "CSV row is invalid"); }
    });
    return this.execute(batch.id, context, inputs, options.dryRun, actor, 2);
  }

  async ingestAutomation(integration: TaskSourceIntegration, input: TaskIntakeRequest, dryRun: boolean): Promise<TaskImportResponse> {
    if (!integration.active || integration.source !== "AUTOMATION") throw new AppError(403, "INTEGRATION_FORBIDDEN", "Active AUTOMATION integration is required");
    if (input.source !== "AUTOMATION") throw new AppError(400, "INVALID_SOURCE_CONTEXT", "Automation endpoint only accepts AUTOMATION source");
    const batch = await this.batches.create({
      context: "INTERNAL_AUTOMATION", source: "AUTOMATION", initiated_by_user_id: null,
      integration_id: integration.id, safe_label: integration.code, dry_run: dryRun,
    });
    const context: TaskIntakeContext = { kind: "INTERNAL_AUTOMATION", integrationId: integration.id,
      requestingDivisionId: integration.requesting_division_id, batchId: batch.id };
    return this.execute(batch.id, context, [input], dryRun, undefined, 1);
  }

  private async execute(batchId: number, context: TaskIntakeContext, inputs: Array<TaskIntakeRequest | AppError>, dryRun: boolean, actor?: TaskActor, rowStart = 1): Promise<TaskImportResponse> {
    const results: TaskImportRowResult[] = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const row = index + rowStart;
      try {
        const input = inputs[index]!;
        if (input instanceof AppError) throw input;
        const resolved = await this.resolve(input);
        if (dryRun) {
          const validation = await this.tasks.validateIntake(context, resolved, actor);
          results.push(validation.duplicateTaskId === null
            ? { row, status: "VALID" }
            : { row, status: "DUPLICATE", task_id: validation.duplicateTaskId });
        } else {
          const outcome = await this.tasks.createFromIntake(context, resolved, actor);
          results.push(outcome.status === "CREATED"
            ? { row, status: "CREATED", task_id: outcome.task.id }
            : { row, status: "DUPLICATE", task_id: outcome.taskId });
        }
      } catch (error) {
        const safe = error instanceof AppError
          ? { code: error.code, message: error.message }
          : { code: "INGESTION_FAILED", message: "Task row could not be processed" };
        results.push({ row, status: "FAILED", ...safe });
      }
    }
    const created = results.filter((item) => item.status === "CREATED").length;
    const failed = results.filter((item) => item.status === "FAILED").length;
    const status = failed === 0 ? "COMPLETED" : failed === results.length ? "FAILED" : "PARTIAL";
    await this.batches.complete(batchId, { status, total_rows: results.length, created_rows: created, failed_rows: failed });
    const human = context.kind === "HUMAN_IMPORT";
    await this.audit.append({
      actor_type: human ? "USER" : "SYSTEM", actor_user_id: human ? context.actorUserId : null,
      action: dryRun ? "TASK_IMPORT_VALIDATED" : "TASK_IMPORT_COMPLETED", object_type: "TASK_IMPORT_BATCH",
      object_id: String(batchId), after_state: { source: human ? "CSV_IMPORT" : context.kind === "ERP_ADAPTER" ? "ERP" : "AUTOMATION",
        dry_run: dryRun, total_rows: results.length, created_rows: created, failed_rows: failed, status }, source: "task_ingestion",
    });
    return { import_id: batchId, status, dry_run: dryRun, total_rows: results.length,
      created_rows: created, failed_rows: failed, results };
  }

  private async resolve(input: TaskIntakeRequest): Promise<TaskIntakeRequest & { ownerDivisionId: number; assignedToUserId: null }> {
    const divisionCode = input.ownerDivision.trim().toUpperCase();
    if (!divisionCode || divisionCode.length > 100 || !/^[A-Z][A-Z0-9_]*$/.test(divisionCode)) {
      throw new AppError(400, "INVALID_DIVISION", "Owner Divisi code is invalid");
    }
    const division = await this.divisions.findByCode(divisionCode);
    if (!division?.active) throw new AppError(400, "INVALID_DIVISION", "Owner Divisi is unknown or inactive");
    if (input.assignee?.trim()) {
      throw new AppError(400, "INVALID_ASSIGNEE", "Assignee import is unavailable until a unique business identifier exists");
    }
    return { ...input, ownerDivision: divisionCode, ownerDivisionId: division.id, assignedToUserId: null };
  }

  private fromCsv(row: CsvTaskRow): TaskIntakeRequest {
    for (const value of Object.values(row)) {
      if (/^[=+@]/.test(value.trim()) || /^-\D/.test(value.trim())) throw new AppError(400, "UNSAFE_CSV_VALUE", "Formula-like CSV value is not allowed");
    }
    const priority = (row.priority || "NORMAL").toUpperCase();
    if (!TASK_PRIORITIES.includes(priority as TaskPriority)) throw new AppError(400, "INVALID_PRIORITY", "Task priority is invalid");
    if (row.deadline && !isStrictDate(row.deadline)) throw new AppError(400, "INVALID_DEADLINE", "Deadline must use YYYY-MM-DD");
    const taskCategory = row.task_category ? row.task_category.toUpperCase() : null;
    if (taskCategory && !TASK_CATEGORIES.includes(taskCategory as never)) throw new AppError(400, "TASK_INVALID_CATEGORY", "Task category is not supported");
    return {
      title: row.title, ownerDivision: row.owner_division, description: row.description || null,
      priority: priority as TaskPriority, assignee: row.assignee || null,
      deadline: row.deadline || null, externalReference: row.external_reference || null, source: "CSV_IMPORT",
      taskCategory: taskCategory as TaskCategory | null,
    };
  }
}

function isStrictDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
