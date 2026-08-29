import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { CollaborationRuleView, CollaborationTaskScope, CreateCollaborationRuleInput, DivisionCollaborationRule, UpdateCollaborationRuleInput } from "../collaboration/types.js";
import type { Division } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

interface RuleRow extends DivisionCollaborationRule {
  source_division: Division;
  target_division: Division;
}

export interface DivisionCollaborationRepository {
  findActiveRule(sourceDivisionId: number, targetDivisionId: number, scope: CollaborationTaskScope): Promise<DivisionCollaborationRule | null>;
  findById(id: number): Promise<CollaborationRuleView | null>;
  listRules(): Promise<CollaborationRuleView[]>;
  createRule(input: CreateCollaborationRuleInput): Promise<CollaborationRuleView>;
  updateRule(id: number, input: UpdateCollaborationRuleInput): Promise<CollaborationRuleView>;
  deactivateRule(id: number): Promise<CollaborationRuleView>;
}

const selection = "*,source_division:divisions!division_collaboration_rules_source_division_id_fkey(*),target_division:divisions!division_collaboration_rules_target_division_id_fkey(*)";

function error(message: string, diagnostic: { code?: string; message?: string; details?: string; hint?: string }): Error {
  if (diagnostic.code === "23505") return new AppError(409, "COLLABORATION_DUPLICATE_RULE", "An active collaboration rule already exists");
  if (diagnostic.code === "23514") return new AppError(400, "COLLABORATION_INVALID_RELATION", "Collaboration rule violates a policy constraint");
  return governanceDatabaseError(message, diagnostic);
}

export class SupabaseDivisionCollaborationRepository implements DivisionCollaborationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findActiveRule(sourceDivisionId: number, targetDivisionId: number, scope: CollaborationTaskScope): Promise<DivisionCollaborationRule | null> {
    const { data, error: queryError } = await this.client.from("division_collaboration_rules").select("*")
      .eq("source_division_id", sourceDivisionId).eq("target_division_id", targetDivisionId)
      .eq("task_scope", scope).eq("active", true).maybeSingle();
    if (queryError) throw error("Unable to resolve collaboration policy", queryError);
    return data as DivisionCollaborationRule | null;
  }

  async findById(id: number): Promise<CollaborationRuleView | null> {
    const { data, error: queryError } = await this.client.from("division_collaboration_rules").select(selection).eq("id", id).maybeSingle();
    if (queryError) throw error("Unable to load collaboration rule", queryError);
    return data as unknown as RuleRow | null;
  }

  async listRules(): Promise<CollaborationRuleView[]> {
    const { data, error: queryError } = await this.client.from("division_collaboration_rules").select(selection)
      .order("active", { ascending: false }).order("created_at", { ascending: true });
    if (queryError) throw error("Unable to list collaboration rules", queryError);
    return (data ?? []) as unknown as RuleRow[];
  }

  async createRule(input: CreateCollaborationRuleInput): Promise<CollaborationRuleView> {
    const { data, error: queryError } = await this.client.from("division_collaboration_rules").insert({
      source_division_id: input.sourceDivisionId, target_division_id: input.targetDivisionId,
      task_scope: input.taskScope, allowed: input.allowed, requires_approval: input.requiresApproval, active: true,
    }).select(selection).single();
    if (queryError) throw error("Unable to create collaboration rule", queryError);
    return data as unknown as RuleRow;
  }

  async updateRule(id: number, input: UpdateCollaborationRuleInput): Promise<CollaborationRuleView> {
    const record: Record<string, boolean> = {};
    if (input.allowed !== undefined) record.allowed = input.allowed;
    if (input.requiresApproval !== undefined) record.requires_approval = input.requiresApproval;
    if (input.active !== undefined) record.active = input.active;
    const { data, error: queryError } = await this.client.from("division_collaboration_rules").update(record).eq("id", id).select(selection).single();
    if (queryError) throw error("Unable to update collaboration rule", queryError);
    return data as unknown as RuleRow;
  }

  deactivateRule(id: number): Promise<CollaborationRuleView> {
    return this.updateRule(id, { active: false });
  }
}
