import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationRuleView, CreateCollaborationRuleInput, DivisionCollaborationRule, UpdateCollaborationRuleInput } from "../../src/collaboration/types.js";
import { AppError } from "../../src/errors.js";
import type { AuditLog, AuditLogInput, Division, Role, SystemAuthorityAssignment } from "../../src/governance/types.js";
import type { AuditRepository } from "../../src/repositories/audit.repository.js";
import type { DivisionsRepository } from "../../src/repositories/divisions.repository.js";
import type { DivisionCollaborationRepository } from "../../src/repositories/division-collaboration.repository.js";
import type { RolesRepository } from "../../src/repositories/roles.repository.js";
import type { NewTaskActivity, TaskActivitiesRepository } from "../../src/repositories/task-activities.repository.js";
import type { TaskRelationshipsRepository } from "../../src/repositories/task-relationships.repository.js";
import type { TaskUsersRepository } from "../../src/repositories/task-users.repository.js";
import type { NewTaskRecord, TasksRepository, TaskUpdateRecord } from "../../src/repositories/tasks.repository.js";
import type { SystemAuthorityRepository } from "../../src/repositories/system-authority.repository.js";
import type { UserManagementRepository } from "../../src/repositories/user-management.repository.js";
import { CollaborationRuleManagementService } from "../../src/services/collaboration-rule-management.service.js";
import { DivisionCollaborationService } from "../../src/services/division-collaboration.service.js";
import { TaskAuthorizationService } from "../../src/services/task-authorization.service.js";
import { TaskService } from "../../src/services/task.service.js";
import { UserManagementService } from "../../src/services/user-management.service.js";
import type { Task, TaskActivity, TaskActor, TaskFilters, TaskReadModel, TaskRelationship, TaskUser } from "../../src/tasks/types.js";
import type { AccessUpdate, ManagedUser, UserManagementStatus } from "../../src/user-management/types.js";

const migrationPath = path.resolve(process.cwd(), "supabase/migrations/202608290005_create_division_collaboration_rules.sql");
const now = "2026-08-29T00:00:00.000Z";
const division = (id: number, code: string): Division => ({ id, code, name: code, active: true, created_at: now, updated_at: now });
const source = division(10, "ONPAGE_B2C"); const target = division(20, "CONTENT_CREATOR"); const other = division(30, "SALES_GROSIR"); const itDivision = division(40, "IT");
const role = (id: number, code: string): Role => ({ id, code, name: code, active: true, created_at: now, updated_at: now });
const roles = [role(1, "STAFF"), role(2, "ADMIN"), role(3, "OWNER")];
const perms = (...values: string[]) => new Set(values);
const actor = (overrides: Partial<TaskActor> = {}): TaskActor => ({ id: 1, active: true, divisionId: 10, roleId: 1, roleCode: "STAFF",
  permissions: perms("task.create", "task.view_assigned", "task.update_assigned", "task.complete_assigned", "task.add_activity"), ...overrides });

class Rules implements DivisionCollaborationRepository {
  rows: CollaborationRuleView[] = [];
  next = 1;
  async findActiveRule(sourceId: number, targetId: number, scope: "ALL") { return this.rows.find((r) => r.source_division_id === sourceId && r.target_division_id === targetId && r.task_scope === scope && r.active) ?? null; }
  async findById(id: number) { return this.rows.find((r) => r.id === id) ?? null; }
  async listRules() { return this.rows; }
  async createRule(input: CreateCollaborationRuleInput) {
    if (await this.findActiveRule(input.sourceDivisionId, input.targetDivisionId, input.taskScope)) throw new AppError(409, "COLLABORATION_DUPLICATE_RULE", "duplicate");
    const row: CollaborationRuleView = { id: this.next++, source_division_id: input.sourceDivisionId, target_division_id: input.targetDivisionId,
      task_scope: input.taskScope, allowed: input.allowed, requires_approval: input.requiresApproval, active: true, created_at: now, updated_at: now,
      source_division: [source, target, other, itDivision].find((d) => d.id === input.sourceDivisionId)!, target_division: [source, target, other, itDivision].find((d) => d.id === input.targetDivisionId)! };
    this.rows.push(row); return row;
  }
  async updateRule(id: number, input: UpdateCollaborationRuleInput) { const row = await this.findById(id); if (!row) throw new Error("missing");
    if (input.allowed !== undefined) row.allowed = input.allowed; if (input.requiresApproval !== undefined) row.requires_approval = input.requiresApproval; if (input.active !== undefined) row.active = input.active; return row; }
  deactivateRule(id: number) { return this.updateRule(id, { active: false }); }
  seed(overrides: Partial<CollaborationRuleView> = {}) { const row: CollaborationRuleView = { id: this.next++, source_division_id: 10, target_division_id: 20,
    task_scope: "ALL", allowed: true, requires_approval: false, active: true, created_at: now, updated_at: now, source_division: source, target_division: target, ...overrides }; this.rows.push(row); return row; }
}
class Tasks implements TasksRepository {
  rows: Task[] = [];
  async create(input: NewTaskRecord) { const row = { ...input, id: this.rows.length + 1, created_at: now, updated_at: now }; this.rows.push(row); return row; }
  async findByExternalReference(input: { source: Task["source"]; sourceReference: string; createdByUserId?: number; integrationId?: number }) { return this.rows.find((row) => row.source === input.source && row.source_reference === input.sourceReference && (input.createdByUserId === undefined ? row.integration_id === input.integrationId : row.created_by_user_id === input.createdByUserId)) ?? null; }
  async findById(id: number) { return this.rows.find((r) => r.id === id) ?? null; }
  async findAll(_filters: TaskFilters = {}): Promise<TaskReadModel[]> { return this.rows.map((r) => ({ ...r, is_overdue: false })); }
  async update(id: number, input: TaskUpdateRecord) { const row = (await this.findById(id))!; Object.assign(row, input); return row; }
}
class Activities implements TaskActivitiesRepository {
  rows: TaskActivity[] = [];
  async append(input: NewTaskActivity) { const row = { ...input, id: this.rows.length + 1, created_at: now }; this.rows.push(row); return row; }
  async findForTask(id: number) { return this.rows.filter((r) => r.task_id === id); }
}
class TaskUsers implements TaskUsersRepository {
  rows: TaskUser[] = [actor(), actor({ id: 2, divisionId: 20 }), actor({ id: 3, divisionId: 20, active: false }), actor({ id: 4, divisionId: null, roleId: null }), actor({ id: 9, divisionId: 40, roleId: 2, roleCode: "ADMIN" })];
  trustedId = 9;
  async findById(id: number) { return this.rows.find((r) => r.id === id) ?? null; }
  async findTrustedAdminActorUser() { return this.rows.find((r) => r.id === this.trustedId)!; }
}
class Audit implements AuditRepository { rows: AuditLog[] = []; async append(input: AuditLogInput) { const row = { ...input, id: this.rows.length + 1,
  actor_user_id: input.actor_user_id ?? null, before_state: (input.before_state ?? null) as AuditLog["before_state"], after_state: (input.after_state ?? null) as AuditLog["after_state"], created_at: now }; this.rows.push(row); return row; } }
const relationships: TaskRelationshipsRepository = { findExact: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({} as TaskRelationship) };

function taskHarness(ruleOverrides?: Partial<DivisionCollaborationRule>) {
  const rules = new Rules(); if (ruleOverrides) rules.seed(ruleOverrides);
  const tasks = new Tasks(); const users = new TaskUsers(); const activities = new Activities(); const audit = new Audit();
  const service = new TaskService(tasks, users, activities, relationships, audit, new TaskAuthorizationService(), () => new Date(now), new DivisionCollaborationService(rules));
  return { service, rules, tasks, users, activities, audit };
}

class ManagedUsers implements UserManagementRepository {
  value: ManagedUser = { id: 9, display_name: "Governance", business_user_code: null, division: itDivision, role: roles[1]!, active: true, telegram_connected: true, created_at: now, updated_at: now };
  async findAll(_status?: UserManagementStatus) { return [this.value]; } async findById(id: number) { return id === this.value.id ? this.value : null; }
  async findNormalizedByLegacyId() { return this.value; } async updateAccess(_id: number, _update: AccessUpdate, _source: string) { return this.value; }
  async updateBusinessUserCode() { return this.value; }
}
class Catalog<T extends Division | Role> { constructor(readonly rows: T[]) {} async findAll(options: { activeOnly?: boolean } = {}) { return options.activeOnly ? this.rows.filter((r) => r.active) : this.rows; } async findByCode(code: string) { return this.rows.find((r) => r.code === code) ?? null; } }
function managementHarness(options: { authority?: boolean; normalized?: Partial<ManagedUser> } = {}) {
  const rules = new Rules(); const taskUsers = new TaskUsers(); const managed = new ManagedUsers(); managed.value = { ...managed.value, ...options.normalized };
  const authority: SystemAuthorityAssignment = { id: 1, user_id: 9, authority_code: "SYSTEM_ADMIN", granted_at: now, granted_by_user_id: null, revoked_at: null, revoked_by_user_id: null, reason: null, created_at: now, updated_at: now };
  const authorities: SystemAuthorityRepository = { findActiveForUser: vi.fn().mockResolvedValue(options.authority === false ? null : authority), countActive: vi.fn(), assign: vi.fn(), revoke: vi.fn() };
  const audit = new Audit(); const divisionsRepo = new Catalog([source, target, other, itDivision]) as unknown as DivisionsRepository;
  const users = new UserManagementService(managed, divisionsRepo, new Catalog(roles) as RolesRepository);
  return { service: new CollaborationRuleManagementService(rules, divisionsRepo, taskUsers, users, authorities, audit), rules, audit, managed };
}

describe("Slice 4 Cross-Divisi collaboration", () => {
  it("1. same-Divisi task remains allowed", async () => { expect((await taskHarness().service.createManual(actor(), { title: "Same" })).owner_division_id).toBe(10); });
  it("2. no-rule Cross-Divisi task is rejected", async () => { await expect(taskHarness().service.createManual(actor(), { title: "No", ownerDivisionId: 20 })).rejects.toMatchObject({ code: "TASK_CROSS_DIVISION_NOT_ALLOWED" }); });
  it("3. allowed Cross-Divisi rule permits task creation", async () => { expect((await taskHarness({ allowed: true }).service.createManual(actor(), { title: "Cross", ownerDivisionId: 20, assignedToUserId: 2 })).owner_division_id).toBe(20); });
  it("4. disabled rule is rejected", async () => { await expect(taskHarness({ active: false }).service.createManual(actor(), { title: "No", ownerDivisionId: 20 })).rejects.toMatchObject({ code: "TASK_CROSS_DIVISION_NOT_ALLOWED" }); });
  it("5. allowed=false is rejected", async () => { await expect(taskHarness({ allowed: false }).service.createManual(actor(), { title: "No", ownerDivisionId: 20 })).rejects.toMatchObject({ code: "TASK_CROSS_DIVISION_NOT_ALLOWED" }); });
  it("6. approval-required returns stable result", async () => { await expect(taskHarness({ allowed: true, requires_approval: true }).service.createManual(actor(), { title: "Wait", ownerDivisionId: 20 })).rejects.toMatchObject({ code: "TASK_COLLABORATION_APPROVAL_REQUIRED" }); });
  it("7. directionality is enforced", async () => { await expect(taskHarness({}).service.createManual(actor({ divisionId: 20 }), { title: "Reverse", ownerDivisionId: 10 })).rejects.toMatchObject({ code: "TASK_CROSS_DIVISION_NOT_ALLOWED" }); });
  it("8. reverse relation is not inferred", async () => { const h = taskHarness({}); expect(await h.rules.findActiveRule(20, 10, "ALL")).toBeNull(); });
  it("9. migration seeds confirmed relation", async () => { const sql = await readFile(migrationPath, "utf8"); expect(sql).toContain("source.code = 'ONPAGE_B2C' and target.code = 'CONTENT_CREATOR'"); });
  it("10. migration contains no speculative seeds", async () => { const sql = await readFile(migrationPath, "utf8"); expect(sql).not.toMatch(/DIGITAL_MARKETING|PURCHASING|SALES_GROSIR|GUDANG/); });
  it("11. target assignee must belong to owner division", async () => { await expect(taskHarness({}).service.createManual(actor(), { title: "Bad", ownerDivisionId: 20, assignedToUserId: 1 })).rejects.toMatchObject({ code: "TASK_CROSS_DIVISION_NOT_ALLOWED" }); });
  it("12. inactive target assignee rejected", async () => { await expect(taskHarness({}).service.createManual(actor(), { title: "Bad", ownerDivisionId: 20, assignedToUserId: 3 })).rejects.toMatchObject({ code: "TASK_INACTIVE_ASSIGNEE" }); });
  it("13. pending assignee rejected", async () => { await expect(taskHarness({}).service.createManual(actor(), { title: "Bad", ownerDivisionId: 20, assignedToUserId: 4 })).rejects.toMatchObject({ code: "TASK_INVALID_ASSIGNEE" }); });
  it("14. requesting division is derived from creator", async () => { expect((await taskHarness({}).service.createManual(actor(), { title: "Derived", ownerDivisionId: 20 })).requesting_division_id).toBe(10); });
  it("15. owner division stores trusted target", async () => { expect((await taskHarness({}).service.createManual(actor(), { title: "Owner", ownerDivisionId: 20 })).owner_division_id).toBe(20); });
  it("16. requester can view their Cross-Divisi task", async () => { const h = taskHarness({}); const created = await h.service.createManual(actor(), { title: "View", ownerDivisionId: 20 }); expect((await h.service.get(actor(), created.id)).id).toBe(created.id); });
  it("17. requester sees SHARED activity", async () => { const h = taskHarness({}); const created = await h.service.createManual(actor(), { title: "View", ownerDivisionId: 20 }); h.activities.rows.push({ id: 1, task_id: created.id, actor_user_id: 2, activity_type: "COMMENT", note: "shared", visibility: "SHARED", evidence_type: "NONE", evidence_reference: null, created_at: now }); expect((await h.service.get(actor(), created.id)).activities).toHaveLength(1); });
  it("18. requester cannot see INTERNAL activity", async () => { const h = taskHarness({}); const created = await h.service.createManual(actor(), { title: "View", ownerDivisionId: 20 }); h.activities.rows.push({ id: 1, task_id: created.id, actor_user_id: 2, activity_type: "COMMENT", note: "internal", visibility: "INTERNAL", evidence_type: "NONE", evidence_reference: null, created_at: now }); expect((await h.service.get(actor(), created.id)).activities).toHaveLength(0); });
  it("19. owner ADMIN sees owner-Divisi task and INTERNAL activity", async () => { const h = taskHarness({}); const created = await h.service.createManual(actor(), { title: "View", ownerDivisionId: 20 }); h.activities.rows.push({ id: 1, task_id: created.id, actor_user_id: 2, activity_type: "COMMENT", note: "internal", visibility: "INTERNAL", evidence_type: "NONE", evidence_reference: null, created_at: now }); const ownerAdmin = actor({ id: 8, divisionId: 20, roleCode: "ADMIN", permissions: perms("task.view_division") }); expect((await h.service.get(ownerAdmin, created.id)).activities).toHaveLength(1); });
  it("20. unrelated division ADMIN cannot view", async () => { const h = taskHarness({}); const created = await h.service.createManual(actor(), { title: "View", ownerDivisionId: 20 }); await expect(h.service.get(actor({ id: 8, divisionId: 30, roleCode: "ADMIN", permissions: perms("task.view_division") }), created.id)).rejects.toMatchObject({ code: "TASK_FORBIDDEN" }); });
  it.each([["21. STAFF", "STAFF"], ["22. business ADMIN", "ADMIN"], ["23. OWNER", "OWNER"]])("%s cannot manage rules without SYSTEM_ADMIN", async (_label, code) => { const h = managementHarness({ authority: false, normalized: { role: roles.find((r) => r.code === code) } }); await expect(h.service.list()).rejects.toMatchObject({ code: "COLLABORATION_GOVERNANCE_FORBIDDEN" }); });
  it("24. active IT SYSTEM_ADMIN can manage rules", async () => { const h = managementHarness(); expect((await h.service.create({ sourceDivisionId: 10, targetDivisionId: 20, taskScope: "ALL", allowed: true, requiresApproval: false })).active).toBe(true); });
  it("25. rule creation is audited", async () => { const h = managementHarness(); await h.service.create({ sourceDivisionId: 10, targetDivisionId: 20, taskScope: "ALL", allowed: true, requiresApproval: false }); expect(h.audit.rows[0]?.action).toBe("COLLABORATION_RULE_CREATED"); });
  it("26. rule update is audited", async () => { const h = managementHarness(); const rule = h.rules.seed(); await h.service.update(rule.id, { requiresApproval: true }); expect(h.audit.rows[0]?.action).toBe("COLLABORATION_RULE_UPDATED"); });
  it("27. rule disable is audited", async () => { const h = managementHarness(); const rule = h.rules.seed(); await h.service.deactivate(rule.id); expect(h.audit.rows[0]?.action).toBe("COLLABORATION_RULE_DISABLED"); });
  it("28. duplicate active rule rejected", async () => { const h = managementHarness(); h.rules.seed(); await expect(h.service.create({ sourceDivisionId: 10, targetDivisionId: 20, taskScope: "ALL", allowed: true, requiresApproval: false })).rejects.toMatchObject({ code: "COLLABORATION_DUPLICATE_RULE" }); });
  it("29. source=target rejected", async () => { await expect(managementHarness().service.create({ sourceDivisionId: 10, targetDivisionId: 10, taskScope: "ALL", allowed: true, requiresApproval: false })).rejects.toMatchObject({ code: "COLLABORATION_INVALID_TARGET_DIVISION" }); });
  it("30. migration enables RLS and creates no public policy", async () => { const sql = await readFile(migrationPath, "utf8"); expect(sql).toContain("enable row level security"); expect(sql).not.toMatch(/create\s+policy/i); });
});
