import { AppError } from "../errors.js";
import type { DivisionCollaborationRepository } from "../repositories/division-collaboration.repository.js";
import type { CollaborationTaskScope, DivisionCollaborationRule } from "../collaboration/types.js";

export interface CollaborationPolicyResolver {
  resolveCollaborationPolicy(sourceDivisionId: number, targetDivisionId: number, scope?: CollaborationTaskScope): Promise<DivisionCollaborationRule | null>;
  assertTaskCollaborationAllowed(sourceDivisionId: number, targetDivisionId: number, scope?: CollaborationTaskScope): Promise<void>;
}

export class DivisionCollaborationService implements CollaborationPolicyResolver {
  constructor(private readonly rules: DivisionCollaborationRepository) {}

  resolveCollaborationPolicy(sourceDivisionId: number, targetDivisionId: number, scope: CollaborationTaskScope = "ALL") {
    return this.rules.findActiveRule(sourceDivisionId, targetDivisionId, scope);
  }

  async assertTaskCollaborationAllowed(sourceDivisionId: number, targetDivisionId: number, scope: CollaborationTaskScope = "ALL"): Promise<void> {
    if (sourceDivisionId === targetDivisionId) return;
    const rule = await this.resolveCollaborationPolicy(sourceDivisionId, targetDivisionId, scope);
    if (!rule || !rule.allowed) {
      throw new AppError(409, "TASK_CROSS_DIVISION_NOT_ALLOWED", "Cross-Divisi task collaboration is not allowed");
    }
    if (rule.requires_approval) {
      throw new AppError(409, "TASK_COLLABORATION_APPROVAL_REQUIRED", "Cross-Divisi task collaboration requires approval");
    }
  }
}
