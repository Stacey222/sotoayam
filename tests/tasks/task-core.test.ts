import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import type { AuditLog, AuditLogInput } from "../../src/governance/types.js";
import type { AuditRepository } from "../../src/repositories/audit.repository.js";
import type { NewTaskActivity, TaskActivitiesRepository } from "../../src/repositories/task-activities.repository.js";
import type { NewTaskRelationship, TaskRelationshipsRepository } from "../../src/repositories/task-relationships.repository.js";
import type { TaskUsersRepository } from "../../src/repositories/task-users.repository.js";
import type { NewTaskRecord, TasksRepository, TaskUpdateRecord } from "../../src/repositories/tasks.repository.js";
import { TaskAuthorizationService } from "../../src/services/task-authorization.service.js";
import { TaskService } from "../../src/services/task.service.js";
import { TelegramRegistrationService } from "../../src/services/telegram-registration.service.js";
import { reconcileIdentitySnapshots } from "../../src/services/identity-reconciliation.service.js";
import { isTaskOverdue } from "../../src/tasks/task-lifecycle.js";
import type { Task, TaskActivity, TaskActor, TaskFilters, TaskReadModel, TaskRelationship, TaskUser } from "../../src/tasks/types.js";

const legacyCategoryValidator = { validate: async (value: string | null | undefined) => {
  if (value === undefined || value === null) return null;
  if (value === "AFFILIATE") return value;
  throw new AppError(400, "TASK_INVALID_CATEGORY", "Task category is not supported");
} };
import { TelegramBot } from "../../src/telegram/bot.js";
import type { TelegramUser } from "../../src/types/index.js";

const migrationPath = path.resolve(process.cwd(), "supabase/migrations/202608290004_create_task_core.sql");
const checkerPath = path.resolve(process.cwd(), "scripts/check-task-schema.ts");
const fixedNow = new Date("2026-08-29T10:00:00.000Z");
const perms = (...values: string[]) => new Set(values);
const staff = (overrides: Partial<TaskActor> = {}): TaskActor => ({ id: 1, active: true, divisionId: 10, roleId: 1, roleCode: "STAFF", permissions: perms("task.create", "task.view_assigned", "task.update_assigned", "task.complete_assigned", "task.add_activity"), ...overrides });
const admin = (overrides: Partial<TaskActor> = {}): TaskActor => ({ ...staff(), id: 40, roleId: 2, roleCode: "ADMIN", permissions: perms(...staff().permissions, "task.view_division"), ...overrides });
const task = (overrides: Partial<Task> = {}): Task => ({
  id: 1, title: "Task", description: null, status: "OPEN", priority: "NORMAL", source: "MANUAL", source_reference: null, task_category: null,
  created_by_user_id: 1, requesting_division_id: 10, owner_division_id: 10, assigned_to_user_id: 1,
  integration_id: null, import_batch_id: null,
  deadline: null, started_at: null, completed_at: null, cancelled_at: null,
  created_at: fixedNow.toISOString(), updated_at: fixedNow.toISOString(), ...overrides,
});

class MemoryTasks implements TasksRepository {
  rows: Task[] = [];
  async create(input: NewTaskRecord) { const row = { ...input, id: this.rows.length + 1, created_at: fixedNow.toISOString(), updated_at: fixedNow.toISOString() }; this.rows.push(row); return row; }
  async findByExternalReference(input: { source: Task["source"]; sourceReference: string; createdByUserId?: number; integrationId?: number }) { return this.rows.find((row) => row.source === input.source && row.source_reference === input.sourceReference && (input.createdByUserId === undefined ? row.integration_id === input.integrationId : row.created_by_user_id === input.createdByUserId)) ?? null; }
  async findById(id: number) { return this.rows.find((row) => row.id === id) ?? null; }
  async findAll(_filters: TaskFilters = {}): Promise<TaskReadModel[]> { return this.rows.map((row) => ({ ...row, is_overdue: isTaskOverdue(row, fixedNow) })); }
  async update(id: number, input: TaskUpdateRecord) { const row = await this.findById(id); if (!row) throw new Error("missing"); Object.assign(row, input); return row; }
}
class MemoryUsers implements TaskUsersRepository {
  rows: TaskUser[] = [staff(), staff({ id: 2 }), staff({ id: 3, active: false }), staff({ id: 5, divisionId: null, roleId: null }), staff({ id: 6, divisionId: 20 }), admin()];
  async findById(id: number) { return this.rows.find((row) => row.id === id) ?? null; }
  async findTrustedAdminActorUser() { return this.rows.find((row) => row.id === 40)!; }
}
class MemoryActivities implements TaskActivitiesRepository {
  rows: TaskActivity[] = [];
  async append(input: NewTaskActivity) { const row = { ...input, id: this.rows.length + 1, created_at: fixedNow.toISOString() }; this.rows.push(row); return row; }
  async findForTask(taskId: number) { return this.rows.filter((row) => row.task_id === taskId); }
}
class MemoryRelationships implements TaskRelationshipsRepository {
  rows: TaskRelationship[] = [];
  async findExact(sourceId: number, targetId: number, type: TaskRelationship["relationship_type"]) { return this.rows.find((row) => row.source_task_id === sourceId && row.target_task_id === targetId && row.relationship_type === type) ?? null; }
  async create(input: NewTaskRelationship) { const row = { ...input, id: this.rows.length + 1, created_at: fixedNow.toISOString() }; this.rows.push(row); return row; }
}
class MemoryAudit implements AuditRepository {
  rows: AuditLog[] = [];
  async append(input: AuditLogInput) { const row = { ...input, id: this.rows.length + 1, actor_user_id: input.actor_user_id ?? null, before_state: (input.before_state ?? null) as AuditLog["before_state"], after_state: (input.after_state ?? null) as AuditLog["after_state"], created_at: fixedNow.toISOString() }; this.rows.push(row); return row; }
}

describe("Slice 3 Task Core acceptance", () => {
  let tasks: MemoryTasks; let users: MemoryUsers; let activities: MemoryActivities; let relationships: MemoryRelationships; let audit: MemoryAudit; let service: TaskService;
  beforeEach(() => { tasks = new MemoryTasks(); users = new MemoryUsers(); activities = new MemoryActivities(); relationships = new MemoryRelationships(); audit = new MemoryAudit(); service = new TaskService(tasks, users, activities, relationships, audit, new TaskAuthorizationService(), () => fixedNow, undefined, legacyCategoryValidator); });

  it("1. creates a valid manual task", async () => { const result = await service.createManual(staff(), { title: "Manual" }); expect(result).toMatchObject({ title: "Manual", source: "MANUAL", status: "OPEN" }); });
  it("writes AFFILIATE only through canonical TaskService", async () => { expect((await service.createManual(staff(), { title: "Affiliate", taskCategory: "AFFILIATE" })).task_category).toBe("AFFILIATE"); });
  it("keeps ordinary existing task creation unclassified", async () => { expect((await service.createManual(staff(), { title: "Ordinary" })).task_category).toBeNull(); });
  it("rejects a speculative task category", async () => { await expect(service.createManual(staff(), { title: "Unknown", taskCategory: "SPECULATIVE" as never })).rejects.toMatchObject({ code: "TASK_INVALID_CATEGORY" }); });
  it("2. requires a title", async () => { await expect(service.createManual(staff(), { title: "  " })).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); });
  it("3. requires an active creator", async () => { await expect(service.createManual(staff({ active: false }), { title: "No" })).rejects.toMatchObject({ code: "TASK_FORBIDDEN" }); });
  it("4. derives requesting division from creator", async () => { expect((await service.createManual(staff(), { title: "Derived" })).requesting_division_id).toBe(10); });
  it("5. defaults owner division to requesting division", async () => { const result = await service.createManual(staff(), { title: "Owner" }); expect(result.owner_division_id).toBe(result.requesting_division_id); });
  it("6. assigns an active same-Divisi user", async () => { expect((await service.createManual(staff(), { title: "Assigned", assignedToUserId: 2 })).assigned_to_user_id).toBe(2); });
  it("7. rejects an inactive assignee", async () => { await expect(service.createManual(staff(), { title: "Bad", assignedToUserId: 3 })).rejects.toMatchObject({ code: "TASK_INACTIVE_ASSIGNEE" }); });
  it("8. rejects a pending assignee", async () => { await expect(service.createManual(staff(), { title: "Bad", assignedToUserId: 5 })).rejects.toMatchObject({ code: "TASK_INVALID_ASSIGNEE" }); });
  it("9. rejects a cross-Divisi assignee", async () => { await expect(service.createManual(staff(), { title: "Bad", assignedToUserId: 6 })).rejects.toMatchObject({ code: "TASK_CROSS_DIVISION_NOT_ALLOWED" }); });
  it("10. permits a valid status transition", async () => { tasks.rows = [task()]; expect((await service.transition(staff(), 1, { status: "IN_PROGRESS" })).status).toBe("IN_PROGRESS"); });
  it("11. rejects an invalid status transition", async () => { tasks.rows = [task({ status: "COMPLETED", completed_at: fixedNow.toISOString() })]; await expect(service.transition(staff(), 1, { status: "OPEN" })).rejects.toMatchObject({ code: "TASK_INVALID_STATUS_TRANSITION" }); });
  it("12. populates started_at only on first IN_PROGRESS", async () => { tasks.rows = [task()]; const result = await service.transition(staff(), 1, { status: "IN_PROGRESS" }); expect(result.started_at).toBe(fixedNow.toISOString()); });
  it("13. populates completed_at", async () => { tasks.rows = [task()]; expect((await service.transition(staff(), 1, { status: "COMPLETED" })).completed_at).toBe(fixedNow.toISOString()); });
  it("14. populates cancelled_at", async () => { tasks.rows = [task()]; expect((await service.transition(staff(), 1, { status: "CANCELLED" })).cancelled_at).toBe(fixedNow.toISOString()); });
  it("15. derives overdue", () => { expect(isTaskOverdue(task({ deadline: "2026-08-28T00:00:00Z" }), fixedNow)).toBe(true); });
  it("16. never marks completed task overdue", () => { expect(isTaskOverdue(task({ deadline: "2026-08-28T00:00:00Z", status: "COMPLETED", completed_at: fixedNow.toISOString() }), fixedNow)).toBe(false); });
  it("17. never marks cancelled task overdue", () => { expect(isTaskOverdue(task({ deadline: "2026-08-28T00:00:00Z", status: "CANCELLED", cancelled_at: fixedNow.toISOString() }), fixedNow)).toBe(false); });
  it("18. lets STAFF view an assigned task", async () => { tasks.rows = [task()]; expect((await service.get(staff(), 1)).id).toBe(1); });
  it("19. denies STAFF an unrelated task", async () => { tasks.rows = [task({ created_by_user_id: 99, assigned_to_user_id: 2 })]; await expect(service.get(staff(), 1)).rejects.toMatchObject({ code: "TASK_FORBIDDEN" }); });
  it("20. lets STAFF update an assigned task", async () => { tasks.rows = [task()]; expect((await service.update(staff(), 1, { priority: "HIGH" })).priority).toBe("HIGH"); });
  it("21. denies STAFF update of unrelated task", async () => { tasks.rows = [task({ assigned_to_user_id: 2 })]; await expect(service.update(staff(), 1, { priority: "HIGH" })).rejects.toMatchObject({ code: "TASK_FORBIDDEN" }); });
  it("22. lets ADMIN view own-Divisi task", async () => { tasks.rows = [task({ assigned_to_user_id: 2 })]; expect((await service.get(admin(), 1)).id).toBe(1); });
  it("23. denies ADMIN automatic unrelated-Divisi visibility", async () => { tasks.rows = [task({ created_by_user_id: 99, requesting_division_id: 30, owner_division_id: 20, assigned_to_user_id: 2 })]; await expect(service.get(admin(), 1)).rejects.toMatchObject({ code: "TASK_FORBIDDEN" }); });
  it("24. does not grant OWNER task modification", async () => { tasks.rows = [task({ assigned_to_user_id: 9 })]; const owner = staff({ id: 9, roleCode: "OWNER", permissions: perms("report.view_cross_division") }); await expect(service.update(owner, 1, { priority: "HIGH" })).rejects.toMatchObject({ code: "TASK_FORBIDDEN" }); });
  it("25. does not let SYSTEM_ADMIN bypass business permissions", async () => { tasks.rows = [task({ assigned_to_user_id: 9 })]; const systemAdmin = staff({ id: 9, permissions: perms() }); await expect(service.update(systemAdmin, 1, { priority: "HIGH" })).rejects.toMatchObject({ code: "TASK_FORBIDDEN" }); });
  it("26. adds SHARED activity", async () => { tasks.rows = [task()]; expect((await service.addActivity(staff(), 1, { activityType: "COMMENT", note: "Shared" })).visibility).toBe("SHARED"); });
  it("27. adds INTERNAL activity", async () => { tasks.rows = [task()]; expect((await service.addActivity(staff(), 1, { activityType: "COMMENT", note: "Internal", visibility: "INTERNAL" })).visibility).toBe("INTERNAL"); });
  it("28. stores a completion note", async () => { tasks.rows = [task()]; await service.transition(staff(), 1, { status: "COMPLETED", note: "Finished" }); expect(activities.rows.find((row) => row.activity_type === "STATUS_CHANGE")?.note).toBe("Finished"); });
  it("29. stores an evidence reference", async () => { tasks.rows = [task()]; await service.transition(staff(), 1, { status: "COMPLETED", evidence: { type: "URL", reference: "https://example.com/evidence" } }); expect(activities.rows.find((row) => row.activity_type === "EVIDENCE")?.evidence_type).toBe("URL"); });
  it("30. rejects self relationships", async () => { tasks.rows = [task()]; await expect(service.addRelationship(staff(), 1, 1, "RELATED_TO")).rejects.toMatchObject({ code: "TASK_RELATIONSHIP_INVALID" }); });
  it("31. rejects duplicate relationships", async () => { tasks.rows = [task(), task({ id: 2 })]; await service.addRelationship(staff(), 1, 2, "RELATED_TO"); await expect(service.addRelationship(staff(), 1, 2, "RELATED_TO")).rejects.toMatchObject({ code: "TASK_RELATIONSHIP_INVALID" }); });
  it("32. creates RELATED_TO", async () => { tasks.rows = [task(), task({ id: 2 })]; expect((await service.addRelationship(staff(), 1, 2, "RELATED_TO")).relationship_type).toBe("RELATED_TO"); });
  it("33. creates PARENT_OF without reciprocal automation", async () => { tasks.rows = [task(), task({ id: 2 })]; await service.addRelationship(staff(), 1, 2, "PARENT_OF"); expect(relationships.rows).toHaveLength(1); });
  it("34. requires and stores a blocked reason", async () => { tasks.rows = [task()]; await expect(service.transition(staff(), 1, { status: "BLOCKED" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); await service.transition(staff(), 1, { status: "BLOCKED", note: "Waiting vendor" }); expect(activities.rows[0]?.note).toBe("Waiting vendor"); });
  it("35. audits TASK_CREATED", async () => { await service.createManual(staff(), { title: "Audit" }); expect(audit.rows.some((row) => row.action === "TASK_CREATED")).toBe(true); });
  it("36. audits TASK_STATUS_CHANGED", async () => { tasks.rows = [task()]; await service.transition(staff(), 1, { status: "IN_PROGRESS" }); expect(audit.rows.some((row) => row.action === "TASK_STATUS_CHANGED")).toBe(true); });
  it("37. audits TASK_ASSIGNED", async () => { await service.createManual(staff(), { title: "Assigned", assignedToUserId: 2 }); expect(audit.rows.some((row) => row.action === "TASK_ASSIGNED")).toBe(true); });
  it("38. enables RLS without public policies", async () => { const sql = await readFile(migrationPath, "utf8"); expect(sql).toContain("alter table public.tasks enable row level security"); expect(sql).not.toMatch(/create policy/i); });
  it("39. preserves active Telegram start", async () => {
    const legacy = { id: 1, telegram_chat_id: 101, telegram_username: null, telegram_first_name: "Safe", name: null, division: "IT", role: "Admin", active: true, stock_alert: false, purchase_alert: false, sales_alert: false, marketing_alert: false, content_alert: false, owner_report: false, system_error: false, created_at: "now", updated_at: "now" } satisfies TelegramUser;
    const sender = { sendMessage: vi.fn() }; const bot = new TelegramBot("token", new TelegramRegistrationService({ upsertTelegramRegistration: vi.fn().mockResolvedValue(legacy) }), { resolveByLegacyTelegramUserId: vi.fn().mockResolvedValue({ status: "ACTIVE", active: true, divisionId: 10, roleId: 2, divisionCode: "IT", roleCode: "ADMIN" }) }, sender, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await bot.handleUpdate({ update_id: 1, message: { text: "/start", chat: { id: 101 } } }); expect(sender.sendMessage.mock.calls[0]?.[1]).toContain("Status: Aktif");
  });
  it("40. preserves identity reconciliation", () => { expect(reconcileIdentitySnapshots([{ id: 1, telegram_chat_id: 101, division: "IT", role: "Admin", active: true }], [{ id: 41, legacy_telegram_user_id: 1, active: true, division_code: "IT", role_code: "ADMIN" }], [{ id: 1, user_id: 41, channel_type: "TELEGRAM", external_id: "101" }])).toEqual({ match: 1, missingNormalized: 0, missingLegacy: 0, mismatch: 0, duplicate: 0 }); });
  it("41. treats production task count as operational information", async () => {
    const checker = await readFile(checkerPath, "utf8");
    expect(checker).toContain("PRODUCTION_TASK_COUNT");
    expect(checker).not.toContain("taskCount === 0");
  });
});
