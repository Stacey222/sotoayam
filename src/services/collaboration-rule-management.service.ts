import type { CreateCollaborationRuleInput, CollaborationRuleView, UpdateCollaborationRuleInput } from "../collaboration/types.js";
import { AppError } from "../errors.js";
import type { AuditRepository } from "../repositories/audit.repository.js";
import type { DivisionsRepository } from "../repositories/divisions.repository.js";
import type { DivisionCollaborationRepository } from "../repositories/division-collaboration.repository.js";
import type { SystemAuthorityRepository } from "../repositories/system-authority.repository.js";
import type { TaskUsersRepository } from "../repositories/task-users.repository.js";
import type { UserManagementService } from "./user-management.service.js";
import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";

export interface CollaborationRuleReader { list(): Promise<CollaborationRuleView[]> }

export class CollaborationRuleManagementService implements CollaborationRuleReader {
  constructor(
    private readonly rules: DivisionCollaborationRepository,
    private readonly divisions: DivisionsRepository,
    private readonly taskUsers: TaskUsersRepository,
    private readonly users: UserManagementService,
    private readonly authorities: SystemAuthorityRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(actorUserId?: number): Promise<CollaborationRuleView[]> {
    await this.authorizedActor(actorUserId);
    return this.rules.listRules();
  }

  async create(input: CreateCollaborationRuleInput, actorUserId?: number): Promise<CollaborationRuleView> {
    const actorId = await this.authorizedActor(actorUserId);
    await this.validateRelation(input.sourceDivisionId, input.targetDivisionId);
    if (!input.allowed && input.requiresApproval) {
      throw new AppError(400, "COLLABORATION_NOT_ALLOWED", "A denied rule cannot require approval");
    }
    const existing = await this.rules.findActiveRule(input.sourceDivisionId, input.targetDivisionId, input.taskScope);
    if (existing) throw new AppError(409, "COLLABORATION_DUPLICATE_RULE", "An active collaboration rule already exists");
    const created = await this.rules.createRule(input);
    await this.audit.append({
      actor_type: "USER", actor_user_id: actorId, action: "COLLABORATION_RULE_CREATED",
      object_type: "DIVISION_COLLABORATION_RULE", object_id: String(created.id), source: "collaboration_admin_api",
      after_state: this.auditState(created),
    });
    return created;
  }

  async update(id: number, input: UpdateCollaborationRuleInput, actorUserId?: number): Promise<CollaborationRuleView> {
    const actorId = await this.authorizedActor(actorUserId);
    const current = await this.required(id);
    const wasActive = current.active;
    const allowed = input.allowed ?? current.allowed;
    const requiresApproval = input.requiresApproval ?? current.requires_approval;
    if (!allowed && requiresApproval) throw new AppError(400, "COLLABORATION_NOT_ALLOWED", "A denied rule cannot require approval");
    if (input.active === true && !current.active) {
      await this.validateRelation(current.source_division_id, current.target_division_id);
      const duplicate = await this.rules.findActiveRule(current.source_division_id, current.target_division_id, current.task_scope);
      if (duplicate && duplicate.id !== current.id) {
        throw new AppError(409, "COLLABORATION_DUPLICATE_RULE", "An active collaboration rule already exists");
      }
    }
    const updated = await this.rules.updateRule(id, input);
    await this.audit.append({
      actor_type: "USER", actor_user_id: actorId,
      action: wasActive && input.active === false ? "COLLABORATION_RULE_DISABLED" : "COLLABORATION_RULE_UPDATED",
      object_type: "DIVISION_COLLABORATION_RULE", object_id: String(id), source: "collaboration_admin_api",
      before_state: this.auditState(current), after_state: this.auditState(updated),
    });
    return updated;
  }

  deactivate(id: number, actorUserId?: number): Promise<CollaborationRuleView> { return this.update(id, { active: false }, actorUserId); }

  private async authorizedActor(actorUserId?: number): Promise<number> {
    const id = actorUserId ?? (await this.taskUsers.findTrustedAdminActorUser()).id;
    const normalized = await this.users.get(id);
    if (!hasSystemAdminCapability({
      active: normalized.active,
      divisionId: normalized.division?.id ?? null,
      roleId: normalized.role?.id ?? null,
      divisionGrantsSystemAuthority: normalized.division?.grants_system_authority,
    })) {
      throw new AppError(403, "COLLABORATION_GOVERNANCE_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
    }
    if (!await this.authorities.findActiveForUser(normalized.id)) {
      throw new AppError(403, "COLLABORATION_GOVERNANCE_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
    }
    return normalized.id;
  }

  private async validateRelation(sourceId: number, targetId: number): Promise<void> {
    if (sourceId === targetId) throw new AppError(400, "COLLABORATION_INVALID_TARGET_DIVISION", "Source and target divisions must differ");
    const divisions = await this.divisions.findAll({ activeOnly: true });
    if (!divisions.some((item) => item.id === sourceId)) throw new AppError(400, "COLLABORATION_INVALID_SOURCE_DIVISION", "Source division is invalid or inactive");
    if (!divisions.some((item) => item.id === targetId)) throw new AppError(400, "COLLABORATION_INVALID_TARGET_DIVISION", "Target division is invalid or inactive");
  }

  private async required(id: number): Promise<CollaborationRuleView> {
    const rule = await this.rules.findById(id);
    if (!rule) throw new AppError(404, "COLLABORATION_RULE_NOT_FOUND", "Collaboration rule not found");
    return rule;
  }

  private auditState(rule: CollaborationRuleView) {
    return { source_division_id: rule.source_division_id, target_division_id: rule.target_division_id,
      task_scope: rule.task_scope, allowed: rule.allowed, requires_approval: rule.requires_approval, active: rule.active };
  }
}
