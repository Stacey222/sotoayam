import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { TaskUser } from "../tasks/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

interface TaskUserRow {
  id: number;
  display_name: string | null;
  active: boolean;
  division_id: number | null;
  role_id: number | null;
  roles: { code: string } | null;
}

export interface TaskUsersRepository {
  findById(id: number): Promise<TaskUser | null>;
  findTrustedAdminActorUser(): Promise<TaskUser>;
}

export interface TaskDirectoryRepository {
  findById(id: number): Promise<TaskUser | null>;
  findActiveByDivision(divisionId: number): Promise<TaskUser[]>;
}

export class SupabaseTaskUsersRepository implements TaskUsersRepository, TaskDirectoryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: number): Promise<TaskUser | null> {
    const { data, error } = await this.client
      .from("users").select("id,display_name,active,division_id,role_id,roles(code)").eq("id", id).maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load normalized task user", error);
    if (!data) return null;
    const row = data as unknown as TaskUserRow;
    return { id: row.id, displayName: row.display_name, active: row.active, divisionId: row.division_id, roleId: row.role_id, roleCode: row.roles?.code ?? null };
  }

  async findActiveByDivision(divisionId: number): Promise<TaskUser[]> {
    const { data, error } = await this.client
      .from("users")
      .select("id,display_name,active,division_id,role_id,roles(code)")
      .eq("active", true)
      .eq("division_id", divisionId)
      .not("role_id", "is", null)
      .order("display_name", { ascending: true });
    if (error) throw governanceDatabaseError("Unable to load task assignees", error);
    return ((data ?? []) as unknown as TaskUserRow[]).map((row) => ({
      id: row.id,
      displayName: row.display_name,
      active: row.active,
      divisionId: row.division_id,
      roleId: row.role_id,
      roleCode: row.roles?.code ?? null,
    }));
  }

  async findTrustedAdminActorUser(): Promise<TaskUser> {
    const { data, error } = await this.client.from("system_authority_assignments")
      .select("user_id").eq("authority_code", "SYSTEM_ADMIN").is("revoked_at", null);
    if (error) throw governanceDatabaseError("Unable to resolve trusted task actor", error);
    const ids = [...new Set((data ?? []).map((row) => Number(row.user_id)))];
    if (ids.length !== 1) throw new AppError(503, "TASK_ACTOR_UNAVAILABLE", "Task API requires exactly one trusted server-side actor during transitional authentication");
    const user = await this.findById(ids[0]!);
    if (!user) throw new AppError(503, "TASK_ACTOR_UNAVAILABLE", "Trusted task actor no longer exists");
    return user;
  }
}
