import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import type { AuditLog, AuditLogInput, Division, Permission } from "../../src/governance/types.js";
import type { UserChannel } from "../../src/identity/types.js";
import type { AuditRepository } from "../../src/repositories/audit.repository.js";
import type { DivisionsRepository } from "../../src/repositories/divisions.repository.js";
import type { DivisionCollaborationRepository } from "../../src/repositories/division-collaboration.repository.js";
import type { PermissionsRepository } from "../../src/repositories/permissions.repository.js";
import type { NewTaskActivity, TaskActivitiesRepository } from "../../src/repositories/task-activities.repository.js";
import type { TaskRelationshipsRepository } from "../../src/repositories/task-relationships.repository.js";
import type { TaskDirectoryRepository, TaskUsersRepository } from "../../src/repositories/task-users.repository.js";
import type { NewTaskRecord, TasksRepository, TaskUpdateRecord } from "../../src/repositories/tasks.repository.js";
import type { UserChannelsRepository } from "../../src/repositories/user-channels.repository.js";
import { DivisionCollaborationService } from "../../src/services/division-collaboration.service.js";
import { TelegramRegistrationService } from "../../src/services/telegram-registration.service.js";
import { TelegramTaskActorService, type TelegramTaskActorResolver } from "../../src/services/task-actor.service.js";
import { TaskAuthorizationService } from "../../src/services/task-authorization.service.js";
import { TaskService } from "../../src/services/task.service.js";
import { TelegramBot } from "../../src/telegram/bot.js";
import { TelegramTaskConsoleService, type TelegramTaskConsole } from "../../src/telegram/task-console.js";
import type { Task, TaskActivity, TaskActor, TaskFilters, TaskReadModel, TaskRelationship, TaskUser } from "../../src/tasks/types.js";

const now = "2026-08-31T10:00:00.000Z";
const division = (id: number, code: string): Division => ({ id, code, name: code, active: true, created_at: now, updated_at: now });
const source = division(10, "ONPAGE_B2C");
const target = division(20, "CONTENT_CREATOR");
const other = division(30, "SALES_GROSIR");
const permissions = (...values: string[]) => new Set(values);
const staffPermissions = () => permissions("task.create", "task.view_assigned", "task.update_assigned", "task.complete_assigned", "task.add_activity");
const actor = (overrides: Partial<TaskActor> = {}): TaskActor => ({
  id: 1, displayName: "Requester", active: true, divisionId: 10, roleId: 1, roleCode: "STAFF", permissions: staffPermissions(), ...overrides,
});
const task = (overrides: Partial<Task> = {}): Task => ({
  id: 1, title: "Produce affiliate video", description: "Five short videos", status: "OPEN", priority: "HIGH", source: "MANUAL",
  source_reference: null, task_category: null, created_by_user_id: 1, requesting_division_id: 10, owner_division_id: 10,
  integration_id: null, import_batch_id: null,
  assigned_to_user_id: 1, deadline: "2026-08-30T23:59:59.999Z", started_at: null, completed_at: null,
  cancelled_at: null, created_at: now, updated_at: now, ...overrides,
});

class MemoryTasks implements TasksRepository {
  rows: Task[] = [];
  async create(input: NewTaskRecord) {
    const id = this.rows.reduce((maximum, row) => Math.max(maximum, row.id), 0) + 1;
    const row = { ...input, id, created_at: now, updated_at: now }; this.rows.push(row); return row;
  }
  async findByExternalReference(input: { source: Task["source"]; sourceReference: string; createdByUserId?: number; integrationId?: number }) { return this.rows.find((row) => row.source === input.source && row.source_reference === input.sourceReference && (input.createdByUserId === undefined ? row.integration_id === input.integrationId : row.created_by_user_id === input.createdByUserId)) ?? null; }
  async findById(id: number) { return this.rows.find((row) => row.id === id) ?? null; }
  async findAll(_filters: TaskFilters = {}): Promise<TaskReadModel[]> {
    return [...this.rows].reverse().map((row) => ({ ...row, is_overdue: Boolean(row.deadline && row.deadline < now && !["COMPLETED", "CANCELLED"].includes(row.status)) }));
  }
  async update(id: number, input: TaskUpdateRecord) { const row = (await this.findById(id))!; Object.assign(row, input); return row; }
}
class MemoryActivities implements TaskActivitiesRepository {
  rows: TaskActivity[] = [];
  async append(input: NewTaskActivity) { const row = { ...input, id: this.rows.length + 1, created_at: now }; this.rows.push(row); return row; }
  async findForTask(id: number) { return this.rows.filter((row) => row.task_id === id); }
}
class MemoryAudit implements AuditRepository {
  rows: AuditLog[] = [];
  async append(input: AuditLogInput) { const row = { ...input, id: this.rows.length + 1, actor_user_id: input.actor_user_id ?? null,
    before_state: (input.before_state ?? null) as AuditLog["before_state"], after_state: (input.after_state ?? null) as AuditLog["after_state"], created_at: now }; this.rows.push(row); return row; }
}
class MemoryDirectory implements TaskUsersRepository, TaskDirectoryRepository {
  rows: TaskUser[] = [
    { ...actor(), displayName: "Requester" },
    { ...actor({ id: 2, divisionId: 20 }), displayName: "Content Staff" },
    { ...actor({ id: 3, divisionId: 20, active: false }), displayName: "Inactive Person" },
    { ...actor({ id: 4, divisionId: 20, roleId: null }), displayName: "Pending Person" },
    { ...actor({ id: 5, divisionId: 30 }), displayName: "Unrelated Person" },
  ];
  async findById(id: number) { return this.rows.find((row) => row.id === id) ?? null; }
  async findTrustedAdminActorUser() { return this.rows[0]!; }
  async findByBusinessUserCode() { return null; }
  async findActiveByDivision(id: number) { return this.rows.filter((row) => row.divisionId === id); }
}
class MemoryDivisions implements DivisionsRepository {
  rows = [source, target, other];
  async findAll(options: { activeOnly?: boolean } = {}) { return options.activeOnly ? this.rows.filter((row) => row.active) : this.rows; }
  async findByCode(code: string) { return this.rows.find((row) => row.code === code) ?? null; }
  async create(input: { code: string; name: string }) { const row = division(this.rows.length + 40, input.code); this.rows.push(row); return row; }
}
class MemoryRules implements DivisionCollaborationRepository {
  rows = [{ id: 1, source_division_id: 10, target_division_id: 20, task_scope: "ALL" as const, allowed: true,
    requires_approval: false, active: true, created_at: now, updated_at: now, source_division: source, target_division: target }];
  async findActiveRule(sourceId: number, targetId: number, scope: "ALL") { return this.rows.find((row) => row.source_division_id === sourceId && row.target_division_id === targetId && row.task_scope === scope && row.active) ?? null; }
  async findById(id: number) { return this.rows.find((row) => row.id === id) ?? null; }
  async listRules() { return this.rows; }
  async createRule(): Promise<never> { throw new Error("not used"); }
  async updateRule(): Promise<never> { throw new Error("not used"); }
  async deactivateRule(): Promise<never> { throw new Error("not used"); }
}
class MutableActors implements TelegramTaskActorResolver {
  values = new Map<number, TaskActor>([[100, actor()], [200, actor({ id: 2, divisionId: 20 })]]);
  calls = 0;
  async resolveTelegramActor(id: number) { this.calls++; const value = this.values.get(id); if (!value) throw new AppError(403, "TASK_FORBIDDEN", "denied"); return value; }
}

const relationships: TaskRelationshipsRepository = {
  findExact: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({} as TaskRelationship),
};

function harness() {
  const tasks = new MemoryTasks(); const activities = new MemoryActivities(); const audit = new MemoryAudit();
  const directory = new MemoryDirectory(); const divisions = new MemoryDivisions(); const rules = new MemoryRules(); const actors = new MutableActors();
  const service = new TaskService(tasks, directory, activities, relationships, audit, new TaskAuthorizationService(), () => new Date(now), new DivisionCollaborationService(rules));
  const console = new TelegramTaskConsoleService(service, actors, directory, divisions, rules, () => new Date(now));
  return { console, service, tasks, activities, audit, directory, divisions, rules, actors };
}

async function driveToOwner(test: ReturnType<typeof harness>, externalId = 100) {
  await test.console.handleCallback(externalId, "tc:c");
  await test.console.handleText(externalId, "New campaign task");
  await test.console.handleCallback(externalId, "tc:cs:d");
  return test.console.handleCallback(externalId, "tc:cp:H");
}
async function driveToReview(test: ReturnType<typeof harness>, ownerId = 10, assigneeId = 1, externalId = 100) {
  await driveToOwner(test, externalId);
  await test.console.handleCallback(externalId, `tc:co:${ownerId}`);
  await test.console.handleCallback(externalId, `tc:ca:${assigneeId}`);
  return test.console.handleCallback(externalId, "tc:cd:s");
}

describe("Slice 5 Telegram Task Console", () => {
  let test: ReturnType<typeof harness>;
  beforeEach(() => { test = harness(); });

  it("1. authorizes an active fully onboarded user for /tasks", async () => {
    expect((await test.console.open(100)).text).toBe("Gwens Task Console");
  });
  it("2. rejects an unknown or deactivated Telegram actor", async () => {
    expect((await test.console.open(999)).text).toBe("Perintah tidak tersedia.");
  });
  it("3. shows only authorized assigned tasks to STAFF", async () => {
    test.tasks.rows = [task(), task({ id: 2, created_by_user_id: 5, requesting_division_id: 30, owner_division_id: 30, assigned_to_user_id: 5, title: "Secret" })];
    const result = await test.console.handleCallback(100, "tc:p:a:0");
    expect(result.text).toContain("Produce affiliate video"); expect(result.text).not.toContain("Secret");
  });
  it("4. allows ADMIN same-Divisi visibility through Task Core", async () => {
    test.actors.values.set(100, actor({ roleCode: "ADMIN", roleId: 2, permissions: permissions(...staffPermissions(), "task.view_division") }));
    test.tasks.rows = [task({ created_by_user_id: 5, assigned_to_user_id: 5, title: "Division task" })];
    expect((await test.console.handleCallback(100, "tc:p:o:0")).text).toContain("Division task");
  });
  it("5. allows legitimate Cross-Divisi requester visibility", async () => {
    test.tasks.rows = [task({ owner_division_id: 20, assigned_to_user_id: 2, title: "Requested content" })];
    expect((await test.console.handleCallback(100, "tc:p:o:0")).text).toContain("Requested content");
  });
  it("6. denies unrelated Divisi visibility", async () => {
    test.tasks.rows = [task({ created_by_user_id: 5, requesting_division_id: 30, owner_division_id: 20, assigned_to_user_id: 2, title: "Unrelated" })];
    expect((await test.console.handleCallback(100, "tc:p:o:0")).text).not.toContain("Unrelated");
  });
  it("7. does not leak INTERNAL activity in requester detail", async () => {
    test.tasks.rows = [task({ owner_division_id: 20, assigned_to_user_id: 2 })];
    test.activities.rows = [{ id: 1, task_id: 1, actor_user_id: 2, activity_type: "COMMENT", note: "Internal secret", visibility: "INTERNAL", evidence_type: "NONE", evidence_reference: null, created_at: now }];
    expect((await test.console.handleCallback(100, "tc:d:1:o:0")).text).not.toContain("Internal secret");
  });
  it("8. paginates task lists at five rows", async () => {
    test.tasks.rows = Array.from({ length: 6 }, (_, index) => task({ id: index + 1, title: `Task ${index + 1}` }));
    const first = await test.console.handleCallback(100, "tc:p:o:0");
    expect(first.inlineKeyboard?.flat().some((item) => item.text === "Next")).toBe(true);
    expect((await test.console.handleCallback(100, "tc:p:o:1")).text).toContain("Halaman 2/2");
  });
  it("9. renders bounded task detail and derived overdue", async () => {
    test.tasks.rows = [task()]; const result = await test.console.handleCallback(100, "tc:d:1:o:0");
    expect(result.text).toContain("Task #1"); expect(result.text).toContain("Owner Divisi: ONPAGE_B2C"); expect(result.text).toContain("Overdue: Yes");
  });
  it("10. starts OPEN task through TaskService", async () => {
    test.tasks.rows = [task()]; await test.console.handleCallback(100, "tc:t:s:1:o:0"); expect(test.tasks.rows[0]?.status).toBe("IN_PROGRESS");
  });
  it("11. blocks IN_PROGRESS task with a required reason", async () => {
    test.tasks.rows = [task({ status: "IN_PROGRESS" })]; await test.console.handleCallback(100, "tc:q:b:1:i:0"); await test.console.handleText(100, "Waiting for product");
    expect(test.tasks.rows[0]?.status).toBe("BLOCKED"); expect(test.activities.rows[0]?.note).toBe("Waiting for product");
  });
  it("12. resumes BLOCKED task through TaskService", async () => {
    test.tasks.rows = [task({ status: "BLOCKED" })]; await test.console.handleCallback(100, "tc:t:r:1:b:0"); expect(test.tasks.rows[0]?.status).toBe("IN_PROGRESS");
  });
  it("13. requires confirmation before completion", async () => {
    test.tasks.rows = [task({ status: "IN_PROGRESS" })]; await test.console.handleCallback(100, "tc:v:c:1:i:0"); expect(test.tasks.rows[0]?.status).toBe("IN_PROGRESS");
    await test.console.handleCallback(100, "tc:t:c:1:i:0"); expect(test.tasks.rows[0]?.status).toBe("COMPLETED");
  });
  it("14. maps invalid transitions to a safe error", async () => {
    test.tasks.rows = [task({ status: "COMPLETED" })]; expect((await test.console.handleCallback(100, "tc:t:s:1:c:0")).text).toContain("Status task sudah berubah");
  });
  it("15. creates a SHARED comment activity", async () => {
    test.tasks.rows = [task()]; await test.console.handleCallback(100, "tc:q:c:1:o:0"); await test.console.handleText(100, "Ready for review");
    expect(test.activities.rows[0]).toMatchObject({ activity_type: "COMMENT", visibility: "SHARED", note: "Ready for review" });
  });
  it("16. creates a same-Divisi MANUAL task only after review confirmation", async () => {
    await driveToReview(test); expect(test.tasks.rows).toHaveLength(0); const review = await test.console.handleCallback(100, "tc:cc");
    expect(review.text).toContain("Task berhasil dibuat"); expect(test.tasks.rows[0]).toMatchObject({ source: "MANUAL", requesting_division_id: 10, owner_division_id: 10, created_by_user_id: 1 });
  });
  it("17. exposes the confirmed allowed Cross-Divisi owner", async () => {
    const result = await driveToOwner(test); expect(result.inlineKeyboard?.flat().map((item) => item.text)).toContain("CONTENT_CREATOR");
  });
  it("18. hides and rejects a denied Cross-Divisi owner", async () => {
    const result = await driveToOwner(test); expect(result.inlineKeyboard?.flat().map((item) => item.text)).not.toContain("SALES_GROSIR");
    expect((await test.console.handleCallback(100, "tc:co:30")).text).toContain("Kolaborasi Cross-Divisi tidak tersedia");
  });
  it("19. hides approval-required collaboration options", async () => {
    test.rules.rows[0]!.requires_approval = true; const result = await driveToOwner(test);
    expect(result.inlineKeyboard?.flat().map((item) => item.text)).not.toContain("CONTENT_CREATOR");
    expect((await test.console.handleCallback(100, "tc:co:20")).text).toContain("memerlukan approval");
  });
  it("20. lists only active onboarded assignees in owner Divisi", async () => {
    await driveToOwner(test); const result = await test.console.handleCallback(100, "tc:co:20"); const labels = result.inlineKeyboard?.flat().map((item) => item.text);
    expect(labels).toContain("Content Staff"); expect(labels).not.toContain("Inactive Person"); expect(labels).not.toContain("Pending Person");
  });
  it("21. rejects an inactive assignee selected through a forged callback", async () => {
    await driveToOwner(test); await test.console.handleCallback(100, "tc:co:20");
    expect((await test.console.handleCallback(100, "tc:ca:3")).text).toContain("Assignee tidak lagi aktif");
  });
  it("22. derives requesting Divisi and actor identity in review", async () => {
    const review = await driveToReview(test, 20, 2); expect(review.text).toContain("Requesting Divisi: ONPAGE_B2C"); expect(review.text).toContain("Owner Divisi: CONTENT_CREATOR");
  });
  it("23. prevents duplicate create callbacks", async () => {
    await driveToReview(test); await test.console.handleCallback(100, "tc:cc"); await test.console.handleCallback(100, "tc:cc"); expect(test.tasks.rows).toHaveLength(1);
  });
  it("24. re-authorizes every callback", async () => {
    await test.console.open(100); const before = test.actors.calls; test.actors.values.delete(100);
    expect((await test.console.handleCallback(100, "tc:l")).text).toBe("Perintah tidak tersedia."); expect(test.actors.calls).toBe(before + 1);
  });
  it("25. cancels a wizard without creating data", async () => {
    await test.console.handleCallback(100, "tc:c"); expect((await test.console.handleCallback(100, "tc:cx")).text).toContain("dibatalkan"); expect(test.tasks.rows).toHaveLength(0);
  });
  it("26. isolates wizard state between users", async () => {
    await test.console.handleCallback(100, "tc:c"); await test.console.handleText(100, "Private title");
    expect((await test.console.handleCallback(200, "tc:cs:d")).text).toBe("Perintah tidak tersedia.");
  });
  it("27. validates explicit deadline format", async () => {
    await driveToOwner(test); await test.console.handleCallback(100, "tc:co:10"); await test.console.handleCallback(100, "tc:ca:1");
    expect((await test.console.handleText(100, "31-08-2026"))?.text).toContain("YYYY-MM-DD");
  });
  it("28. routes /tasks and task callbacks through single-message editing with acknowledgement", async () => {
    const taskConsole: TelegramTaskConsole = { open: vi.fn().mockResolvedValue({ text: "Gwens Task Console" }), handleCallback: vi.fn().mockResolvedValue({ text: "My Tasks" }), handleText: vi.fn() };
    const sender = { sendMessage: vi.fn(), editMessage: vi.fn(), answerCallbackQuery: vi.fn() };
    const bot = new TelegramBot("token", new TelegramRegistrationService({ upsertTelegramRegistration: vi.fn() }), { resolveByLegacyTelegramUserId: vi.fn() }, sender, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, taskConsole);
    await bot.handleUpdate({ update_id: 1, message: { text: "/tasks", chat: { id: 100, type: "private" }, from: { id: 100 } } });
    await bot.handleUpdate({ update_id: 2, callback_query: { id: "cb", from: { id: 100 }, data: "tc:l", message: { message_id: 7, chat: { id: 100, type: "private" } } } });
    expect(sender.sendMessage).toHaveBeenCalledTimes(1); expect(sender.answerCallbackQuery).toHaveBeenCalledWith("cb"); expect(sender.editMessage).toHaveBeenCalledWith(100, 7, "My Tasks", undefined);
  });
  it("29. resolves Telegram actors from normalized channel and role permissions without SYSTEM_ADMIN bypass", async () => {
    const channel: UserChannel = { id: 1, user_id: 1, channel_type: "TELEGRAM", external_id: "100", username: null, active: true, verified_at: now, created_at: now, updated_at: now };
    const channels: UserChannelsRepository = { findByExternalIdentity: vi.fn().mockResolvedValue(channel) };
    const users: TaskUsersRepository = { findById: vi.fn().mockResolvedValue(test.directory.rows[0]), findTrustedAdminActorUser: vi.fn() };
    const permission: Permission = { id: 1, code: "task.create", name: "Create", active: true, created_at: now, updated_at: now };
    const permissionRepo: PermissionsRepository = { findAll: vi.fn(), findForRoleCode: vi.fn().mockResolvedValue([permission]) };
    const resolved = await new TelegramTaskActorService(channels, users, permissionRepo).resolveTelegramActor(100);
    expect(resolved.id).toBe(1); expect(resolved.permissions.has("task.create")).toBe(true);
  });
  it("30. creates through the confirmed allowed Cross-Divisi rule", async () => {
    await driveToReview(test, 20, 2); await test.console.handleCallback(100, "tc:cc");
    expect(test.tasks.rows[0]).toMatchObject({ requesting_division_id: 10, owner_division_id: 20, assigned_to_user_id: 2, source: "MANUAL" });
  });
  it("31. does not duplicate completion activity on a repeated callback", async () => {
    test.tasks.rows = [task({ status: "IN_PROGRESS" })];
    await test.console.handleCallback(100, "tc:t:c:1:i:0");
    expect((await test.console.handleCallback(100, "tc:t:c:1:i:0")).text).toContain("Status task sudah berubah");
    expect(test.activities.rows.filter((row) => row.activity_type === "STATUS_CHANGE")).toHaveLength(1);
  });
  it("32. refuses to expose Task Console in a Telegram group", async () => {
    const taskConsole: TelegramTaskConsole = { open: vi.fn(), handleCallback: vi.fn(), handleText: vi.fn() };
    const sender = { sendMessage: vi.fn() };
    const bot = new TelegramBot("token", new TelegramRegistrationService({ upsertTelegramRegistration: vi.fn() }), { resolveByLegacyTelegramUserId: vi.fn() }, sender, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, taskConsole);
    await bot.handleUpdate({ update_id: 1, message: { text: "/tasks", chat: { id: -900, type: "group" }, from: { id: 100 } } });
    expect(taskConsole.open).not.toHaveBeenCalled(); expect(sender.sendMessage.mock.calls[0]?.[1]).toContain("private chat");
  });
});
