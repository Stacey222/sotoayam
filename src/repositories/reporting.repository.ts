import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { Task } from "../tasks/types.js";
import type { TaskStatusReportFilters } from "../reporting/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface ReportingRepository {
  findAffiliateTasks?(startAt: string, endAt: string): Promise<Task[]>;
  findTasksForReport?(filters: TaskStatusReportFilters, startAt: string, endAt: string): Promise<Task[]>;
}

export class SupabaseReportingRepository implements ReportingRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findAffiliateTasks(startAt: string, endAt: string): Promise<Task[]> {
    return this.findTasksForReport({ division: "CONTENT_CREATOR", taskCategory: "AFFILIATE" }, startAt, endAt);
  }

  async findTasksForReport(filters: TaskStatusReportFilters, startAt: string, endAt: string): Promise<Task[]> {
    let divisionId: number | undefined;
    if (filters.division) {
      const division = await this.client.from("divisions").select("id").eq("code", filters.division).maybeSingle();
      if (division.error) throw governanceDatabaseError("Unable to resolve report division", division.error);
      if (!division.data) throw new AppError(404, "REPORT_DIVISION_NOT_FOUND", "Report division was not found");
      divisionId = Number(division.data.id);
    }
    let query = this.client.from("tasks")
      .select("id,title,status,priority,source,source_reference,task_category,created_by_user_id,integration_id,import_batch_id,requesting_division_id,owner_division_id,assigned_to_user_id,deadline,started_at,completed_at,cancelled_at,created_at,updated_at")
      .gte("created_at", startAt).lte("created_at", endAt).order("created_at", { ascending: false });
    if (divisionId !== undefined) query = query.eq("owner_division_id", divisionId);
    if (filters.taskCategory) query = query.eq("task_category", filters.taskCategory);
    if (filters.statuses?.length) query = query.in("status", filters.statuses);
    const { data, error } = await query;
    if (error) throw governanceDatabaseError("Unable to query task status report", error);
    return (data ?? []) as Task[];
  }
}
