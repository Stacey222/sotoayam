import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskCategoryCatalogEntry } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface TaskCategoriesRepository {
  findAll(): Promise<TaskCategoryCatalogEntry[]>;
  create(input: { code: string; name: string; actorUserId: number }): Promise<TaskCategoryCatalogEntry>;
  update(id: number, input: { name?: string; active?: boolean; actorUserId: number }): Promise<TaskCategoryCatalogEntry>;
  delete(id: number, actorUserId: number): Promise<TaskCategoryCatalogEntry>;
}

export class SupabaseTaskCategoriesRepository implements TaskCategoriesRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findAll(): Promise<TaskCategoryCatalogEntry[]> {
    const { data, error } = await this.client.from("task_categories").select("*").order("name");
    if (error) throw governanceDatabaseError("Unable to load task categories", error);
    return (data ?? []) as TaskCategoryCatalogEntry[];
  }

  async create(input: { code: string; name: string; actorUserId: number }): Promise<TaskCategoryCatalogEntry> {
    const { data, error } = await this.client.rpc("create_task_category", {
      p_code: input.code, p_name: input.name, p_actor_user_id: input.actorUserId, p_source: "taxonomy_admin_api",
    }).single();
    if (error) throw governanceDatabaseError("Unable to create task category", error);
    return data as TaskCategoryCatalogEntry;
  }

  async update(id: number, input: { name?: string; active?: boolean; actorUserId: number }): Promise<TaskCategoryCatalogEntry> {
    const { data, error } = await this.client.rpc("update_task_category", {
      p_category_id: id, p_name: input.name ?? null, p_active: input.active ?? null,
      p_actor_user_id: input.actorUserId, p_source: "taxonomy_admin_api",
    }).single();
    if (error) throw governanceDatabaseError("Unable to update task category", error);
    return data as TaskCategoryCatalogEntry;
  }

  async delete(id: number, actorUserId: number): Promise<TaskCategoryCatalogEntry> {
    const { data, error } = await this.client.rpc("delete_task_category", {
      p_category_id: id, p_actor_user_id: actorUserId, p_source: "taxonomy_admin_api",
    }).single();
    if (error) throw governanceDatabaseError("Unable to delete task category", error);
    return data as TaskCategoryCatalogEntry;
  }
}

