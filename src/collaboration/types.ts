import type { Division } from "../governance/types.js";

export type CollaborationTaskScope = "ALL";

export interface DivisionCollaborationRule {
  id: number;
  source_division_id: number;
  target_division_id: number;
  task_scope: CollaborationTaskScope;
  allowed: boolean;
  requires_approval: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CollaborationRuleView extends DivisionCollaborationRule {
  source_division: Division;
  target_division: Division;
}

export interface CreateCollaborationRuleInput {
  sourceDivisionId: number;
  targetDivisionId: number;
  taskScope: CollaborationTaskScope;
  allowed: boolean;
  requiresApproval: boolean;
}

export interface UpdateCollaborationRuleInput {
  allowed?: boolean;
  requiresApproval?: boolean;
  active?: boolean;
}
