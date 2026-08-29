import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { TaskRelationship, TaskRelationshipType } from "../tasks/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface NewTaskRelationship {
  source_task_id: number;
  target_task_id: number;
  relationship_type: TaskRelationshipType;
  created_by_user_id: number;
}

export interface TaskRelationshipsRepository {
  findExact(sourceId: number, targetId: number, type: TaskRelationshipType): Promise<TaskRelationship | null>;
  create(input: NewTaskRelationship): Promise<TaskRelationship>;
}

export class SupabaseTaskRelationshipsRepository implements TaskRelationshipsRepository {
  constructor(private readonly client: SupabaseClient) {}
  async findExact(sourceId: number, targetId: number, type: TaskRelationshipType): Promise<TaskRelationship | null> {
    const { data, error } = await this.client.from("task_relationships").select("*")
      .eq("source_task_id", sourceId).eq("target_task_id", targetId).eq("relationship_type", type).maybeSingle();
    if (error) throw governanceDatabaseError("Unable to inspect task relationship", error);
    return data as TaskRelationship | null;
  }
  async create(input: NewTaskRelationship): Promise<TaskRelationship> {
    const { data, error } = await this.client.from("task_relationships").insert(input).select("*").single();
    if (error?.code === "23505") throw new AppError(409, "TASK_RELATIONSHIP_INVALID", "Duplicate task relationship");
    if (error) throw governanceDatabaseError("Unable to create task relationship", error);
    return data as TaskRelationship;
  }
}
