import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task, TaskFilters, TaskReadModel } from "../tasks/types.js";
import { isTaskOverdue } from "../tasks/task-lifecycle.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export type NewTaskRecord = Omit<Task, "id" | "created_at" | "updated_at">;
export type TaskUpdateRecord = Partial<Pick<Task, "title" | "description" | "priority" | "deadline" | "assigned_to_user_id" | "task_category" | "status" | "started_at" | "completed_at" | "cancelled_at">>;

export interface TasksRepository {
  create(input: NewTaskRecord): Promise<Task>;
  findByExternalReference(input: { source: Task["source"]; sourceReference: string; createdByUserId?: number; integrationId?: number }): Promise<Task | null>;
  findById(id: number): Promise<Task | null>;
  findAll(filters?: TaskFilters): Promise<TaskReadModel[]>;
  update(id: number, input: TaskUpdateRecord): Promise<Task>;
}

export class SupabaseTasksRepository implements TasksRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: NewTaskRecord): Promise<Task> {
    const { data, error } = await this.client.from("tasks").insert(input).select("*").single();
    if (error) throw governanceDatabaseError("Unable to create task", error);
    return data as Task;
  }

  async findByExternalReference(input: { source: Task["source"]; sourceReference: string; createdByUserId?: number; integrationId?: number }): Promise<Task | null> {
    let query = this.client.from("tasks").select("*").eq("source", input.source).eq("source_reference", input.sourceReference);
    query = input.createdByUserId === undefined
      ? query.eq("integration_id", input.integrationId!)
      : query.eq("created_by_user_id", input.createdByUserId);
    const { data, error } = await query.maybeSingle();
    if (error) throw governanceDatabaseError("Unable to check task external reference", error);
    return data as Task | null;
  }

  async findById(id: number): Promise<Task | null> {
    const { data, error } = await this.client.from("tasks").select("*").eq("id", id).maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load task", error);
    return data as Task | null;
  }

  async findAll(filters: TaskFilters = {}): Promise<TaskReadModel[]> {
    let query = this.client.from("tasks").select("*").order("created_at", { ascending: false });
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.priority) query = query.eq("priority", filters.priority);
    if (filters.assignedToUserId) query = query.eq("assigned_to_user_id", filters.assignedToUserId);
    if (filters.ownerDivisionId) query = query.eq("owner_division_id", filters.ownerDivisionId);
    const { data, error } = await query;
    if (error) throw governanceDatabaseError("Unable to list tasks", error);
    const rows = (data ?? []) as Task[];
    return rows.map((task) => ({ ...task, is_overdue: isTaskOverdue(task) }))
      .filter((task) => filters.overdue === undefined || task.is_overdue === filters.overdue);
  }

  async update(id: number, input: TaskUpdateRecord): Promise<Task> {
    const { data, error } = await this.client.from("tasks").update(input).eq("id", id).select("*").single();
    if (error) throw governanceDatabaseError("Unable to update task", error);
    return data as Task;
  }
}
