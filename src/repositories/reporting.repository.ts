import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { Task } from "../tasks/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface ReportingRepository {
  findAffiliateTasks(startAt: string, endAt: string): Promise<Task[]>;
}

export class SupabaseReportingRepository implements ReportingRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findAffiliateTasks(startAt: string, endAt: string): Promise<Task[]> {
    const division = await this.client.from("divisions").select("id").eq("code", "CONTENT_CREATOR").eq("active", true).maybeSingle();
    if (division.error) throw governanceDatabaseError("Unable to resolve report Divisi", division.error);
    if (!division.data) throw new AppError(503, "REPORT_DEFINITION_UNAVAILABLE", "CONTENT_CREATOR Divisi is unavailable");
    const { data, error } = await this.client.from("tasks")
      .select("id,title,status,priority,source,source_reference,task_category,created_by_user_id,integration_id,import_batch_id,requesting_division_id,owner_division_id,assigned_to_user_id,deadline,started_at,completed_at,cancelled_at,created_at,updated_at")
      .eq("owner_division_id", division.data.id).eq("task_category", "AFFILIATE")
      .gte("created_at", startAt).lte("created_at", endAt).order("created_at", { ascending: false });
    if (error) throw governanceDatabaseError("Unable to query affiliate task report", error);
    return (data ?? []) as Task[];
  }
}
