import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { AppError } from "../../src/errors.js";
import { parseTaskCsv, CSV_MAX_BYTES, CSV_MAX_ROWS } from "../../src/ingestion/csv-parser.js";
import { csvImportRoutes, internalTaskIngestionRoutes } from "../../src/routes/task-ingestion.routes.js";
import type { AuditLog, AuditLogInput, Division } from "../../src/governance/types.js";
import type { AuditRepository } from "../../src/repositories/audit.repository.js";
import type { DivisionsRepository } from "../../src/repositories/divisions.repository.js";
import type { ImportBatchRepository, NewImportBatch, TaskSourceIntegration } from "../../src/repositories/task-ingestion.repository.js";
import type { NewTaskRecord, TasksRepository, TaskUpdateRecord } from "../../src/repositories/tasks.repository.js";
import type { TaskActivitiesRepository } from "../../src/repositories/task-activities.repository.js";
import type { TaskRelationshipsRepository } from "../../src/repositories/task-relationships.repository.js";
import type { TaskUsersRepository } from "../../src/repositories/task-users.repository.js";

const legacyCategoryValidator = { validate: async (value: string | null | undefined) => {
  if (value === undefined || value === null) return null;
  if (value === "AFFILIATE") return value;
  throw new AppError(400, "TASK_INVALID_CATEGORY", "Task category is not supported");
} };
import { DivisionCollaborationService } from "../../src/services/division-collaboration.service.js";
import { TaskAuthorizationService } from "../../src/services/task-authorization.service.js";
import { TaskIngestionService } from "../../src/services/task-ingestion.service.js";
import { TaskService } from "../../src/services/task.service.js";
import type { Task, TaskActor, TaskFilters, TaskReadModel, TaskUser } from "../../src/tasks/types.js";

const now = "2026-09-01T00:00:00.000Z";
const actor = (overrides: Partial<TaskActor> = {}): TaskActor => ({ id: 7, displayName: "Importer", active: true,
  divisionId: 10, roleId: 2, roleCode: "ADMIN", permissions: new Set(["task.create", "task.import"]), ...overrides });
const division = (id: number, code: string, active = true): Division => ({ id, code, name: code, active, created_at: now, updated_at: now });

class Tasks implements TasksRepository {
  rows: Task[] = [];
  async create(input: NewTaskRecord) { const row: Task = { ...input, id: this.rows.length + 1, created_at: now, updated_at: now }; this.rows.push(row); return row; }
  async findByExternalReference(input: { source: Task["source"]; sourceReference: string; createdByUserId?: number; integrationId?: number }) {
    return this.rows.find((row) => row.source === input.source && row.source_reference === input.sourceReference
      && (input.createdByUserId === undefined ? row.integration_id === input.integrationId : row.created_by_user_id === input.createdByUserId)) ?? null;
  }
  async findById(id: number) { return this.rows.find((row) => row.id === id) ?? null; }
  async findAll(_filters: TaskFilters = {}): Promise<TaskReadModel[]> { return this.rows.map((row) => ({ ...row, is_overdue: false })); }
  async update(id: number, update: TaskUpdateRecord) { const row = (await this.findById(id))!; Object.assign(row, update); return row; }
}
class Users implements TaskUsersRepository {
  rows: TaskUser[] = [actor(), { ...actor({ id: 2 }), displayName: "Assignee" }, { ...actor({ id: 3, active: false }), displayName: "Inactive" },
    { ...actor({ id: 4, roleId: null }), displayName: "Pending" }, { ...actor({ id: 5, divisionId: 20 }), displayName: "Other Divisi" }];
  codes = new Map([["GW-IT-001", 2], ["GW-IT-INACTIVE", 3], ["GW-IT-PENDING", 4], ["GW-CC-001", 5]]);
  async findById(id: number) { return this.rows.find((row) => row.id === id) ?? null; }
  async findTrustedAdminActorUser() { return this.rows[0]!; }
  async findByBusinessUserCode(code: string) { const id = this.codes.get(code); return id ? this.findById(id) : null; }
  async findActiveByDivision(id: number) { return this.rows.filter((row) => row.active && row.divisionId === id); }
}
class Divisions implements DivisionsRepository {
  rows = [division(10, "IT"), division(20, "CONTENT_CREATOR"), division(30, "INACTIVE", false)];
  async findAll(options: { activeOnly?: boolean } = {}) { return options.activeOnly ? this.rows.filter((row) => row.active) : this.rows; }
  async findByCode(code: string) { return this.rows.find((row) => row.code === code) ?? null; }
  async create(input: { code: string; name: string }) { const row = division(this.rows.length + 10, input.code); this.rows.push(row); return row; }
}
class Batches implements ImportBatchRepository {
  rows: Array<NewImportBatch & { id: number; status?: string; total_rows?: number; created_rows?: number; failed_rows?: number }> = [];
  async create(input: NewImportBatch) { const row = { ...input, id: this.rows.length + 1 }; this.rows.push(row); return { id: row.id }; }
  async complete(id: number, input: { status: "COMPLETED" | "PARTIAL" | "FAILED"; total_rows: number; created_rows: number; failed_rows: number }) { Object.assign(this.rows.find((row) => row.id === id)!, input); }
}
class Audit implements AuditRepository {
  rows: AuditLog[] = [];
  async append(input: AuditLogInput) { const row: AuditLog = { ...input, id: this.rows.length + 1, actor_user_id: input.actor_user_id ?? null,
    before_state: (input.before_state ?? null) as AuditLog["before_state"], after_state: (input.after_state ?? null) as AuditLog["after_state"], created_at: now }; this.rows.push(row); return row; }
}
const activities: TaskActivitiesRepository = { append: async () => { throw new Error("unused"); }, findForTask: async () => [] };
const relationships: TaskRelationshipsRepository = { create: async () => { throw new Error("unused"); }, findExact: async () => null };

function harness(options: { collaboration?: "allow" | "deny" | "approval" } = {}) {
  const tasks = new Tasks(); const users = new Users(); const divisions = new Divisions(); const batches = new Batches(); const audit = new Audit();
  const collaboration = new DivisionCollaborationService({
    findActiveRule: async () => options.collaboration === "allow" || options.collaboration === "approval"
      ? { id: 1, source_division_id: 10, target_division_id: 20, task_scope: "ALL", allowed: true,
          requires_approval: options.collaboration === "approval", active: true, created_at: now, updated_at: now }
      : null,
    findById: async () => null, listRules: async () => [], createRule: async () => { throw new Error("unused"); },
    updateRule: async () => { throw new Error("unused"); }, deactivateRule: async () => { throw new Error("unused"); },
  });
  const core = new TaskService(tasks, users, activities, relationships, audit, new TaskAuthorizationService(), () => new Date(now), collaboration, legacyCategoryValidator);
  return { service: new TaskIngestionService(core, divisions, batches, audit, users), tasks, batches, audit, core };
}

const header = "title,owner_division,description,priority,assignee,deadline,external_reference";
const csv = (...rows: string[]) => [header, ...rows].join("\n");

describe("Slice 6 task ingestion", () => {
  it("imports a valid same-Divisi row through TaskService", async () => { const h = harness(); const result = await h.service.importCsv(actor(), csv("Patch server,IT,,HIGH,,2026-09-02,job-1"), { dryRun: false, safeLabel: "tasks.csv" }); expect(result).toMatchObject({ status: "COMPLETED", created_rows: 1, failed_rows: 0 }); expect(h.tasks.rows[0]).toMatchObject({ source: "CSV_IMPORT", created_by_user_id: 7, requesting_division_id: 10, owner_division_id: 10 }); });
  it("accepts canonical AFFILIATE classification through intake", async () => { const h = harness({ collaboration: "allow" }); const input = "title,owner_division,task_category\nAffiliate task,CONTENT_CREATOR,AFFILIATE"; await h.service.importCsv(actor(), input, { dryRun: false, safeLabel: null }); expect(h.tasks.rows[0]?.task_category).toBe("AFFILIATE"); });
  it("rejects unsupported intake categories", async () => { const h = harness(); const input = "title,owner_division,task_category\nUnknown,IT,SPECULATIVE"; const result = await h.service.importCsv(actor(), input, { dryRun: false, safeLabel: null }); expect(result.results[0]).toMatchObject({ status: "FAILED", code: "TASK_INVALID_CATEGORY" }); });
  it("allows a configured cross-Divisi row", async () => { const h = harness({ collaboration: "allow" }); expect((await h.service.importCsv(actor(), csv("Create asset,CONTENT_CREATOR,,,,,cross-1"), { dryRun: false, safeLabel: null })).created_rows).toBe(1); });
  it("denies an unconfigured cross-Divisi row", async () => { const result = await harness({ collaboration: "deny" }).service.importCsv(actor(), csv("Create asset,CONTENT_CREATOR,,,,,"), { dryRun: false, safeLabel: null }); expect(result.results[0]).toMatchObject({ status: "FAILED", code: "TASK_CROSS_DIVISION_NOT_ALLOWED" }); });
  it("does not auto-approve approval-required collaboration", async () => { const result = await harness({ collaboration: "approval" }).service.importCsv(actor(), csv("Create asset,CONTENT_CREATOR,,,,,"), { dryRun: false, safeLabel: null }); expect(result.results[0]).toMatchObject({ status: "FAILED", code: "TASK_COLLABORATION_APPROVAL_REQUIRED" }); });
  it.each([
    ["missing title", ",IT,,,,,", "VALIDATION_ERROR"], ["unknown division", "Task,UNKNOWN,,,,,", "INVALID_DIVISION"],
    ["inactive division", "Task,INACTIVE,,,,,", "INVALID_DIVISION"], ["invalid priority", "Task,IT,,EXTREME,,,", "INVALID_PRIORITY"],
    ["invalid deadline", "Task,IT,,,,tomorrow,", "INVALID_DEADLINE"], ["invalid assignee", "Task,IT,,,123,,", "BUSINESS_USER_CODE_INVALID"],
  ])("rejects %s at row level", async (_label, row, code) => { const result = await harness().service.importCsv(actor(), csv(row), { dryRun: false, safeLabel: null }); expect(result.results[0]).toMatchObject({ status: "FAILED", code }); });
  it("supports partial success and preserves row order", async () => { const h = harness(); const result = await h.service.importCsv(actor(), csv("Good,IT,,,,,a", ",IT,,,,,b", "Also good,IT,,,,,c"), { dryRun: false, safeLabel: null }); expect(result).toMatchObject({ status: "PARTIAL", total_rows: 3, created_rows: 2, failed_rows: 1 }); expect(result.results.map((row) => [row.row, row.status])).toEqual([[2, "CREATED"], [3, "FAILED"], [4, "CREATED"]]); });
  it("dry-run fully validates and creates zero tasks", async () => { const h = harness(); const result = await h.service.importCsv(actor(), csv("Safe,IT,,,,,dry-1"), { dryRun: true, safeLabel: null }); expect(result.results[0]?.status).toBe("VALID"); expect(h.tasks.rows).toHaveLength(0); expect(h.audit.rows.at(-1)?.action).toBe("TASK_IMPORT_VALIDATED"); });
  it("resolves a normalized business user code for CSV assignment", async () => { const h = harness(); const result = await h.service.importCsv(actor(), csv("Assigned,IT,,,gw-it-001,,assigned-1"), { dryRun: false, safeLabel: null }); expect(result.failed_rows).toBe(0); expect(h.tasks.rows[0]?.assigned_to_user_id).toBe(2); });
  it("fails an unknown business user code without creating a task", async () => { const h = harness(); const result = await h.service.importCsv(actor(), csv("Unknown,IT,,,GW-IT-404,,"), { dryRun: false, safeLabel: null }); expect(result.results[0]).toMatchObject({ status: "FAILED", code: "BUSINESS_USER_NOT_FOUND" }); expect(h.tasks.rows).toHaveLength(0); });
  it.each([["inactive", "GW-IT-INACTIVE", "TASK_INACTIVE_ASSIGNEE"], ["pending", "GW-IT-PENDING", "TASK_INVALID_ASSIGNEE"], ["wrong Divisi", "GW-CC-001", "TASK_CROSS_DIVISION_NOT_ALLOWED"]])
  ("fails an %s assignee through canonical TaskService authorization", async (_label, code, expected) => { const h = harness(); const result = await h.service.importCsv(actor(), csv(`Rejected,IT,,,${code},,`), { dryRun: false, safeLabel: null }); expect(result.results[0]).toMatchObject({ status: "FAILED", code: expected }); expect(h.tasks.rows).toHaveLength(0); });
  it("dry-run resolves a business user code identically without creating a task", async () => { const h = harness(); const result = await h.service.importCsv(actor(), csv("Dry assigned,IT,,,GW-IT-001,,dry-assigned"), { dryRun: true, safeLabel: null }); expect(result.results[0]?.status).toBe("VALID"); expect(h.tasks.rows).toHaveLength(0); });
  it("detects a repeated external reference without a second task", async () => { const h = harness(); await h.service.importCsv(actor(), csv("First,IT,,,,,same"), { dryRun: false, safeLabel: null }); const repeated = await h.service.importCsv(actor(), csv("Second,IT,,,,,same"), { dryRun: false, safeLabel: null }); expect(repeated.results[0]).toMatchObject({ status: "DUPLICATE", task_id: 1 }); expect(h.tasks.rows).toHaveLength(1); });
  it("requires active task.import authority", async () => { await expect(harness().service.importCsv(actor({ permissions: new Set(["task.create"]) }), csv("No,IT,,,,,"), { dryRun: false, safeLabel: null })).rejects.toMatchObject({ code: "TASK_FORBIDDEN" }); });
  it("records safe batch metadata and completion audit without CSV rows", async () => { const h = harness(); await h.service.importCsv(actor(), csv("Audited,IT,,,,,"), { dryRun: false, safeLabel: "safe.csv" }); expect(h.batches.rows[0]).toMatchObject({ initiated_by_user_id: 7, safe_label: "safe.csv", total_rows: 1 }); expect(JSON.stringify(h.audit.rows.at(-1))).not.toContain("Audited"); });
  it("creates automation tasks with integration origin and no fake human", async () => { const h = harness(); const integration: TaskSourceIntegration = { id: 55, code: "WAREHOUSE_SYNC", name: "Warehouse", source: "AUTOMATION", requesting_division_id: 10, active: true }; await h.service.ingestAutomation(integration, { source: "AUTOMATION", title: "Sync", ownerDivision: "IT", externalReference: "sync-1" }, false); expect(h.tasks.rows[0]).toMatchObject({ created_by_user_id: null, integration_id: 55, requesting_division_id: 10 }); expect(h.audit.rows.find((row) => row.action === "TASK_CREATED")?.actor_type).toBe("SYSTEM"); });
  it("rejects inactive automation identity", async () => { const integration: TaskSourceIntegration = { id: 55, code: "SYNC", name: "Sync", source: "AUTOMATION", requesting_division_id: 10, active: false }; await expect(harness().service.ingestAutomation(integration, { source: "AUTOMATION", title: "Sync", ownerDivision: "IT" }, false)).rejects.toMatchObject({ code: "INTEGRATION_FORBIDDEN" }); });
  it("does not accept Telegram IDs or database actor IDs as CSV headers", () => { expect(() => parseTaskCsv("title,owner_division,telegram_id\nTask,IT,123")).toThrowError(expect.objectContaining({ code: "CSV_UNEXPECTED_COLUMN" })); });
});

describe("bounded CSV parser", () => {
  it("rejects oversized files", () => { expect(() => parseTaskCsv(`title,owner_division\n${"x".repeat(CSV_MAX_BYTES)}`)).toThrowError(expect.objectContaining({ code: "CSV_FILE_TOO_LARGE" })); });
  it("rejects too many rows", () => { const body = ["title,owner_division", ...Array.from({ length: CSV_MAX_ROWS + 1 }, (_, index) => `Task ${index},IT`)].join("\n"); expect(() => parseTaskCsv(body)).toThrowError(expect.objectContaining({ code: "CSV_ROW_LIMIT_EXCEEDED" })); });
  it("rejects malformed quoting", () => { expect(() => parseTaskCsv('title,owner_division\n"broken,IT')).toThrowError(expect.objectContaining({ code: "CSV_MALFORMED" })); });
  it("rejects duplicate headers", () => { expect(() => parseTaskCsv("title,title,owner_division\na,b,IT")).toThrowError(expect.objectContaining({ code: "CSV_DUPLICATE_HEADER" })); });
  it("rejects unexpected columns", () => { expect(() => parseTaskCsv("title,owner_division,created_by\na,IT,7")).toThrowError(expect.objectContaining({ code: "CSV_UNEXPECTED_COLUMN" })); });
  it("supports escaped quotes and embedded newlines", () => { expect(parseTaskCsv('title,owner_division,description\n"Quoted ""task""",IT,"line 1\nline 2"')[0]).toMatchObject({ title: 'Quoted "task"', description: "line 1\nline 2" }); });
});

describe("ingestion HTTP boundaries", () => {
  it("protects CSV import with the Admin API key", async () => {
    const app = Fastify();
    await app.register(csvImportRoutes, { service: { importCsv: async () => ({}) } as never,
      actorResolver: { resolveTrustedActor: async () => actor() }, adminApiKey: "admin-test-key" });
    const response = await app.inject({ method: "POST", url: "/csv", headers: { "content-type": "text/csv" }, payload: "title,owner_division\nTask,IT" });
    expect(response.statusCode).toBe(401); await app.close();
  });
  it("accepts bounded UTF-8 CSV and derives the normalized actor server-side", async () => {
    const app = Fastify(); let resolvedActor: TaskActor | undefined;
    await app.register(csvImportRoutes, { service: { importCsv: async (value: TaskActor) => { resolvedActor = value; return { dry_run: true }; } } as never,
      actorResolver: { resolveTrustedActor: async () => actor() }, adminApiKey: "admin-test-key" });
    const response = await app.inject({ method: "POST", url: "/csv?dry_run=true", headers: { "content-type": "text/csv; charset=utf-8", "x-admin-api-key": "admin-test-key" }, payload: "title,owner_division\nTask,IT" });
    expect(response.statusCode).toBe(200); expect(resolvedActor?.id).toBe(7); await app.close();
  });
  it("rejects unsafe client filesystem labels", async () => {
    const app = Fastify();
    await app.register(csvImportRoutes, { service: { importCsv: async () => ({}) } as never,
      actorResolver: { resolveTrustedActor: async () => actor() }, adminApiKey: "admin-test-key" });
    const response = await app.inject({ method: "POST", url: "/csv", headers: { "content-type": "text/csv", "x-admin-api-key": "admin-test-key", "x-import-label": "C:\\private\\tasks.csv" }, payload: "title,owner_division\nTask,IT" });
    expect(response.statusCode).toBe(400); expect(response.json().message).toContain("Import label"); await app.close();
  });
  it("requires both internal authorization and a registered integration identity", async () => {
    const app = Fastify();
    await app.register(internalTaskIngestionRoutes, { service: { ingestAutomation: async () => ({}) } as never,
      integrations: { findActiveByCode: async () => null, hasActiveCapability: async () => false }, internalApiKey: "internal-test-key" });
    const unauthorized = await app.inject({ method: "POST", url: "/tasks", payload: { title: "Task", owner_division: "IT" } });
    const unknown = await app.inject({ method: "POST", url: "/tasks", headers: { "x-internal-api-key": "internal-test-key", "x-integration-code": "UNKNOWN" }, payload: { title: "Task", owner_division: "IT" } });
    expect(unauthorized.statusCode).toBe(401); expect(unknown.statusCode).toBe(403); expect(unknown.json().message).toContain("unknown or inactive"); await app.close();
  });
  it("rejects an active integration without TASK_CREATE even when the shared key is valid", async () => {
    const app = Fastify(); const integration: TaskSourceIntegration = { id: 55, code: "SYNC", name: "Sync", source: "AUTOMATION", requesting_division_id: 10, active: true };
    await app.register(internalTaskIngestionRoutes, { service: { ingestAutomation: async () => ({}) } as never,
      integrations: { findActiveByCode: async () => integration, hasActiveCapability: async () => false }, internalApiKey: "internal-test-key" });
    const response = await app.inject({ method: "POST", url: "/tasks", headers: { "x-internal-api-key": "internal-test-key", "x-integration-code": "SYNC" }, payload: { title: "Task", owner_division: "IT" } });
    expect(response.statusCode).toBe(403); expect(response.json().code).toBe("INTEGRATION_CAPABILITY_REQUIRED"); await app.close();
  });
  it("continues to canonical intake only with active TASK_CREATE", async () => {
    const app = Fastify(); const integration: TaskSourceIntegration = { id: 55, code: "SYNC", name: "Sync", source: "AUTOMATION", requesting_division_id: 10, active: true }; let called = 0;
    await app.register(internalTaskIngestionRoutes, { service: { ingestAutomation: async () => { called += 1; return {}; } } as never,
      integrations: { findActiveByCode: async () => integration, hasActiveCapability: async (_id, capability) => capability === "TASK_CREATE" }, internalApiKey: "internal-test-key" });
    const response = await app.inject({ method: "POST", url: "/tasks", headers: { "x-internal-api-key": "internal-test-key", "x-integration-code": "SYNC" }, payload: { title: "Task", owner_division: "IT" } });
    expect(response.statusCode).toBe(200); expect(called).toBe(1); await app.close();
  });
  it("does not accept caller-supplied human authority on automation intake", async () => {
    const app = Fastify(); const integration: TaskSourceIntegration = { id: 55, code: "SYNC", name: "Sync", source: "AUTOMATION", requesting_division_id: 10, active: true };
    await app.register(internalTaskIngestionRoutes, { service: { ingestAutomation: async () => ({}) } as never,
      integrations: { findActiveByCode: async () => integration, hasActiveCapability: async () => true }, internalApiKey: "internal-test-key" });
    const response = await app.inject({ method: "POST", url: "/tasks", headers: { "x-internal-api-key": "internal-test-key", "x-integration-code": "SYNC" }, payload: { title: "Task", owner_division: "IT", created_by_user_id: 7 } });
    expect(response.statusCode).toBe(400); expect(response.json().message).toContain("created_by_user_id"); await app.close();
  });
});

describe("Slice 6 migration contract", () => {
  it("is additive, enables RLS, and creates no public policies or fake integrations", async () => { const sql = await readFile(path.resolve(process.cwd(), "supabase/migrations/202609010001_create_task_ingestion_foundation.sql"), "utf8"); expect(sql).toContain("create table public.task_source_integrations"); expect(sql).toContain("create table public.task_import_batches"); expect(sql.match(/enable row level security/g)).toHaveLength(2); expect(sql).not.toMatch(/create\s+policy/i); expect(sql).not.toMatch(/insert\s+into\s+public\.task_source_integrations/i); });
  it("enforces durable human and integration idempotency", async () => { const sql = await readFile(path.resolve(process.cwd(), "supabase/migrations/202609010001_create_task_ingestion_foundation.sql"), "utf8"); expect(sql).toContain("tasks_human_external_reference_uidx"); expect(sql).toContain("tasks_integration_external_reference_uidx"); expect(sql).toContain("tasks_exactly_one_origin_check"); });
});
