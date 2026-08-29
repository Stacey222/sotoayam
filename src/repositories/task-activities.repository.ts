import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskActivity, TaskActivityType, TaskEvidenceType, TaskVisibility } from "../tasks/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface NewTaskActivity {
  task_id: number;
  actor_user_id: number;
  activity_type: TaskActivityType;
  note: string | null;
  visibility: TaskVisibility;
  evidence_type: TaskEvidenceType;
  evidence_reference: string | null;
}

export interface TaskActivitiesRepository { append(input: NewTaskActivity): Promise<TaskActivity> }

export class SupabaseTaskActivitiesRepository implements TaskActivitiesRepository {
  constructor(private readonly client: SupabaseClient) {}
  async append(input: NewTaskActivity): Promise<TaskActivity> {
    const { data, error } = await this.client.from("task_activities").insert(input).select("*").single();
    if (error) throw governanceDatabaseError("Unable to append task activity", error);
    return data as TaskActivity;
  }
}
