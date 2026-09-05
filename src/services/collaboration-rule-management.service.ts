import type { CreateCollaborationRuleInput, CollaborationRuleView, UpdateCollaborationRuleInput } from "../collaboration/types.js";
import { AppError } from "../errors.js";
import type { AuditRepository } from "../repositories/audit.repository.js";
import type { DivisionsRepository } from "../repositories/divisions.repository.js";
import type { DivisionCollaborationRepository } from "../repositories/division-collaboration.repository.js";
import type { SystemAuthorityRepository } from "../repositories/system-authority.repository.js";
import type { TaskActor } from "../tasks/types.js";

export interface CollaborationRuleReader { list(actor: TaskActor): Promise<CollaborationRuleView[]> }

export class CollaborationRuleManagementService implements CollaborationRuleReader {
  constructor(
    private readonly rules: DivisionCollaborationRepository,
    private readonly divisions: DivisionsRepository,
    private readonly authorities: SystemAuthorityRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(actor: TaskActor): Promise<CollaborationRuleView[]> {
    await this.authorizedActor(actor);
    return this.rules.listRules();
  }

  async create(actor: TaskActor, input: CreateCollaborationRuleInput): Promise<CollaborationRuleView> {
    const actorId = await this.authorizedActor(actor);
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

  async update(actor: TaskActor, id: number, input: UpdateCollaborationRuleInput): Promise<CollaborationRuleView> {
    const actorId = await this.authorizedActor(actor);
    const current = await this.required(id);
    const wasActive = current.active;
    const allowed = input.allowed ?? current.allowed;
    const requiresApproval = input.requiresApproval ?? current.requires_approval;
    if (!allowed && requiresApproval) throw new AppError(400, "COLLABORATION_NOT_ALLOWED", "A denied rule cannot require approval");
    const updated = await this.rules.updateRule(id, input);
    await this.audit.append({
      actor_type: "USER", actor_user_id: actorId,
      action: wasActive && input.active === false ? "COLLABORATION_RULE_DISABLED" : "COLLABORATION_RULE_UPDATED",
      object_type: "DIVISION_COLLABORATION_RULE", object_id: String(id), source: "collaboration_admin_api",
      before_state: this.auditState(current), after_state: this.auditState(updated),
    });
    return updated;
  }

  deactivate(actor: TaskActor, id: number): Promise<CollaborationRuleView> { return this.update(actor, id, { active: false }); }

  private async authorizedActor(actor: TaskActor): Promise<number> {
    if (!actor.active || actor.divisionCode !== "IT") {
      throw new AppError(403, "COLLABORATION_GOVERNANCE_FORBIDDEN", "Active IT SYSTEM_ADMIN authority is required");
    }
    if (!await this.authorities.findActiveForUser(actor.id)) {
      throw new AppError(403, "COLLABORATION_GOVERNANCE_FORBIDDEN", "Active IT SYSTEM_ADMIN authority is required");
    }
    return actor.id;
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
