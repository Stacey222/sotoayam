import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ReportingRepository } from "../../src/repositories/reporting.repository.js";
import { reportsRoutes } from "../../src/routes/reports.routes.js";
import { ReportingService } from "../../src/services/reporting.service.js";
import { TelegramRegistrationService } from "../../src/services/telegram-registration.service.js";
import type { TelegramTaskActorResolver } from "../../src/services/task-actor.service.js";
import { TelegramBot } from "../../src/telegram/bot.js";
import { TelegramOwnerConsoleService } from "../../src/telegram/owner-console.js";
import type { Task, TaskActor } from "../../src/tasks/types.js";

const now = new Date("2026-09-01T05:00:00.000Z"); // 12:00 Asia/Jakarta
const owner = (overrides: Partial<TaskActor> = {}): TaskActor => ({ id: 9, displayName: "Owner", active: true,
  divisionId: 10, divisionCode: "IT", roleId: 3, roleCode: "OWNER",
  permissions: new Set(["report.view_division", "report.view_cross_division"]), ...overrides });
const task = (overrides: Partial<Task> = {}): Task => ({ id: 1, title: "Affiliate operation", description: null,
  status: "OPEN", priority: "NORMAL", source: "MANUAL", source_reference: null, task_category: "AFFILIATE",
  created_by_user_id: 9, integration_id: null, import_batch_id: null, requesting_division_id: 10,
  owner_division_id: 20, assigned_to_user_id: null, deadline: null, started_at: null, completed_at: null,
  cancelled_at: null, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", ...overrides });

class Reports implements ReportingRepository {
  constructor(readonly rows: Task[] = []) {}
  async findAffiliateTasks(startAt: string, endAt: string) {
    return this.rows.filter((row) => row.owner_division_id === 20 && row.task_category === "AFFILIATE"
      && row.created_at >= startAt && row.created_at <= endAt);
  }
  async findTasksForReport(filters: { division?: string; taskCategory?: string; statuses?: Task["status"][] }, startAt: string, endAt: string) {
    const divisionIds: Record<string, number> = { CONTENT_CREATOR: 20, IT: 10, FULFILLMENT: 30 };
    return this.rows.filter((row) => (filters.division === undefined || row.owner_division_id === divisionIds[filters.division])
      && (filters.taskCategory === undefined || row.task_category === filters.taskCategory)
      && (!filters.statuses?.length || filters.statuses.includes(row.status))
      && row.created_at >= startAt && row.created_at <= endAt);
  }
}
const service = (rows: Task[] = []) => new ReportingService(new Reports(rows), "Asia/Jakarta", () => now);

describe("AFFILIATE_TASK_STATUS reporting", () => {
  const rows = [
    task({ id: 1, status: "OPEN", deadline: "2026-09-01T04:00:00.000Z" }),
    task({ id: 2, status: "IN_PROGRESS", deadline: "2026-09-03T05:00:00.000Z" }),
    task({ id: 3, status: "BLOCKED" }),
    task({ id: 4, status: "COMPLETED", completed_at: "2026-09-01T03:00:00.000Z" }),
    task({ id: 5, status: "CANCELLED", cancelled_at: "2026-09-01T03:00:00.000Z" }),
    task({ id: 6, status: "DRAFT" }),
    task({ id: 7, task_category: null, title: "affiliate free-text must not match" }),
    task({ id: 8, owner_division_id: 10 }),
  ];
  it("aggregates the canonical CONTENT_CREATOR/AFFILIATE definition", async () => expect(await service(rows).affiliateTaskStatus(owner(), "TODAY")).toMatchObject({ total: 4, open: 1, inProgress: 1, blocked: 1, completed: 1 }));
  it("excludes CANCELLED and DRAFT from total with explicit counts", async () => expect(await service(rows).affiliateTaskStatus(owner(), "TODAY")).toMatchObject({ excludedCancelled: 1, excludedDraft: 1 }));
  it("derives OVERDUE without storing a status", async () => expect((await service(rows).affiliateTaskStatus(owner(), "TODAY")).overdue).toBe(1));
  it("counts deadlines within the next seven days", async () => expect((await service(rows).affiliateTaskStatus(owner(), "TODAY")).upcomingDeadlines).toBe(1));
  it("calculates completion rate over non-draft/non-cancelled total", async () => expect((await service(rows).affiliateTaskStatus(owner(), "TODAY")).completionRate).toBe(25));
  it("does not invent a percentage for a zero denominator", async () => expect((await service().affiliateTaskStatus(owner(), "TODAY")).completionRate).toBeNull());
  it.each([["TODAY", "2026-08-31T17:00:00.000Z"], ["LAST_7_DAYS", "2026-08-25T17:00:00.000Z"], ["LAST_30_DAYS", "2026-08-02T17:00:00.000Z"]] as const)("uses %s Asia/Jakarta boundary", async (window, start) => expect((await service(rows).affiliateTaskStatus(owner(), window)).startAt).toBe(start));
  it("handles the local-midnight boundary consistently", async () => { const rowsAtBoundary = [task({ created_at: "2026-08-31T16:59:59.999Z" }), task({ id: 2, created_at: "2026-08-31T17:00:00.000Z" })]; expect((await service(rowsAtBoundary).affiliateTaskStatus(owner(), "TODAY")).total).toBe(1); });
  it("rejects an ordinary user without reporting permission", async () => await expect(service(rows).affiliateTaskStatus(owner({ roleCode: "STAFF", permissions: new Set() }), "TODAY")).rejects.toMatchObject({ code: "OWNER_REPORT_FORBIDDEN" }));
  it("does not let SYSTEM_ADMIN/ADMIN imply reporting permission", async () => await expect(service(rows).affiliateTaskStatus(owner({ roleCode: "ADMIN", permissions: new Set() }), "TODAY")).rejects.toMatchObject({ code: "OWNER_REPORT_FORBIDDEN" }));
  it("authorizes bounded drill-down without activities", async () => { const result = await service(rows).drillDown(owner(), "TODAY", "BLOCKED", 0); expect(result.items).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("activity"); });
  it("returns an empty production-safe report", async () => expect(await service().affiliateTaskStatus(owner(), "LAST_7_DAYS")).toMatchObject({ total: 0, completionRate: null }));
  it("supports generic division/category/status filters without origin assumptions", async () => {
    const generic = task({ title: "Fulfillment exception", owner_division_id: 30, task_category: "RETURNS", status: "BLOCKED" });
    await expect(service([generic, task()]).taskStatus(owner(), {
      division: "FULFILLMENT", taskCategory: "RETURNS", statuses: ["BLOCKED"],
    }, "TODAY")).resolves.toMatchObject({ definition: "TASK_STATUS", division: "FULFILLMENT",
      taskCategory: "RETURNS", statuses: ["BLOCKED"], total: 1, blocked: 1 });
  });
  it("allows division-scoped reporting with only the division permission", async () => {
    const scoped = owner({ divisionCode: "IT", permissions: new Set(["report.view_division"]) });
    await expect(service([task({ owner_division_id: 10 })]).taskStatus(scoped, { division: "IT" }, "TODAY"))
      .resolves.toMatchObject({ total: 1 });
    await expect(service().taskStatus(scoped, {}, "TODAY")).rejects.toMatchObject({ code: "OWNER_REPORT_FORBIDDEN" });
  });
});

class Actors implements TelegramTaskActorResolver {
  calls = 0;
  constructor(public actor: TaskActor = owner()) {}
  async resolveTelegramActor() { this.calls += 1; return this.actor; }
}

describe("Owner Telegram Console", () => {
  it("denies /owner to a normal user", async () => expect((await new TelegramOwnerConsoleService(new Actors(owner({ roleCode: "STAFF", permissions: new Set() })), service()).open(100)).text).toBe("Perintah tidak tersedia."));
  it("authorizes an active OWNER", async () => expect((await new TelegramOwnerConsoleService(new Actors(), service()).open(100)).text).toBe("Sotoayam Owner Console"));
  it("renders only confirmed menu features", async () => { const response = await new TelegramOwnerConsoleService(new Actors(), service()).open(100); expect(JSON.stringify(response.inlineKeyboard)).toContain("Business Report"); expect(JSON.stringify(response.inlineKeyboard)).not.toContain("Slice 9"); });
  it("does not expose the legacy report dropdown for fresh provenance", async () => {
    const console = new TelegramOwnerConsoleService(new Actors(), service(), undefined, false);
    const menu = await console.open(100);
    expect(JSON.stringify(menu)).not.toMatch(/Business Report|CONTENT_CREATOR|Affiliate Task Status/);
    expect(await console.handleCallback(100, "oc:r")).toEqual({ text: "Perintah tidak tersedia." });
    expect(await console.handleCallback(100, "oc:v:7")).toEqual({ text: "Perintah tidak tersedia." });
  });
  it("navigates to a compact report result", async () => { const response = await new TelegramOwnerConsoleService(new Actors(), service([task()])).handleCallback(100, "oc:v:7"); expect(response.text).toContain("Affiliate Task Status"); expect(response.text.length).toBeLessThan(4096); });
  it("re-authorizes every callback", async () => { const actors = new Actors(); const console = new TelegramOwnerConsoleService(actors, service()); await console.open(100); await console.handleCallback(100, "oc:r"); expect(actors.calls).toBe(2); });
  it("bounds drill-down output", async () => { const rows = Array.from({ length: 20 }, (_, index) => task({ id: index + 1, status: "BLOCKED", title: "x".repeat(200) })); const response = await new TelegramOwnerConsoleService(new Actors(), service(rows)).handleCallback(100, "oc:l:b:7:0"); expect(response.text.length).toBeLessThan(4096); expect(response.text.match(/Status:/g)).toHaveLength(5); });
  it("acknowledges and edits callbacks as a single message", async () => {
    const console = new TelegramOwnerConsoleService(new Actors(), service());
    const sender = { sendMessage: vi.fn(), editMessage: vi.fn(), answerCallbackQuery: vi.fn() };
    const bot = new TelegramBot("token", new TelegramRegistrationService({ upsertTelegramRegistration: vi.fn() }), { resolveByLegacyTelegramUserId: vi.fn() }, sender, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined, console);
    await bot.handleUpdate({ update_id: 1, callback_query: { id: "cb", from: { id: 100 }, data: "oc:r", message: { message_id: 7, chat: { id: 100, type: "private" } } } });
    expect(sender.answerCallbackQuery).toHaveBeenCalledWith("cb"); expect(sender.editMessage).toHaveBeenCalledTimes(1); expect(sender.sendMessage).not.toHaveBeenCalled();
  });
});

describe("protected reporting API and schema contract", () => {
  it("rejects a missing API key", async () => { const app = Fastify(); await app.register(reportsRoutes, { service: service(), actorResolver: { resolveOwnerActor: async () => owner() }, adminApiKey: "key" }); const response = await app.inject({ method: "GET", url: "/content-creator/affiliate-task-status" }); expect(response.statusCode).toBe(401); await app.close(); });
  it("requires business reporting permission", async () => { const app = Fastify(); await app.register(reportsRoutes, { service: service(), actorResolver: { resolveOwnerActor: async () => owner({ roleCode: "ADMIN", permissions: new Set() }) }, adminApiKey: "key" }); const response = await app.inject({ method: "GET", url: "/content-creator/affiliate-task-status", headers: { "x-admin-api-key": "key" } }); expect(response.statusCode).toBe(403); await app.close(); });
  it("returns an authorized report independently of Telegram", async () => { const app = Fastify(); await app.register(reportsRoutes, { service: service([task()]), actorResolver: { resolveOwnerActor: async () => owner() }, adminApiKey: "key" }); const response = await app.inject({ method: "GET", url: "/content-creator/affiliate-task-status?window=TODAY", headers: { "x-admin-api-key": "key" } }); expect(response.statusCode).toBe(200); expect(response.json().data.total).toBe(1); await app.close(); });
  it("exposes the generic TASK_STATUS route with normalized filters", async () => {
    const app = Fastify();
    await app.register(reportsRoutes, { service: service([task({ owner_division_id: 30, task_category: "RETURNS", status: "BLOCKED" })]),
      actorResolver: { resolveOwnerActor: async () => owner() }, adminApiKey: "key", legacyAliasEnabled: false });
    const response = await app.inject({ method: "GET",
      url: "/task-status?window=TODAY&division=fulfillment&task_category=returns&statuses=blocked",
      headers: { "x-admin-api-key": "key" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ definition: "TASK_STATUS", total: 1, blocked: 1 });
    await app.close();
  });
  it("uses an extensible canonical category without title/source inference", async () => { const migration = await readFile(path.resolve("supabase/migrations/202609010003_add_task_category.sql"), "utf8"); const repository = await readFile(path.resolve("src/repositories/reporting.repository.ts"), "utf8"); expect(migration).toContain("task_category ~ '^[A-Z][A-Z0-9_]{0,49}$'"); expect(migration).not.toContain("AFFILIATE"); expect(repository).toContain("filters.taskCategory"); expect(repository).not.toMatch(/\.ilike\(|title.*AFFILIATE/i); });
  it("keeps RLS and existing data without backfill or public policy", async () => { const migration = await readFile(path.resolve("supabase/migrations/202609010003_add_task_category.sql"), "utf8"); expect(migration).not.toMatch(/update\s+public\.tasks|create\s+policy|disable\s+row\s+level|delete\s+from|truncate/i); });
});
