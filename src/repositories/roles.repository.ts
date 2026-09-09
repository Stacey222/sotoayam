import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagedRole, Role } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface RolesRepository {
  findAll(options?: { activeOnly?: boolean }): Promise<Role[]>;
  findByCode(code: string): Promise<Role | null>;
  findManaged?(): Promise<ManagedRole[]>;
  rename?(id: number, name: string, actorUserId: number): Promise<ManagedRole>;
}

export class SupabaseRolesRepository implements RolesRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findAll(options: { activeOnly?: boolean } = {}): Promise<Role[]> {
    let query = this.client.from("roles").select("*").order("name", { ascending: true });
    if (options.activeOnly) query = query.eq("active", true);
    const { data, error } = await query;
    if (error) throw governanceDatabaseError("Unable to load roles", error);
    return (data ?? []) as Role[];
  }

  async findByCode(code: string): Promise<Role | null> {
    const { data, error } = await this.client.from("roles").select("*").eq("code", code).maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load role", error);
    return data as Role | null;
  }

  async findManaged(): Promise<ManagedRole[]> {
    const { data, error } = await this.client.from("roles").select("*").eq("system_managed", true).order("name");
    if (error) throw governanceDatabaseError("Unable to load managed roles", error);
    return (data ?? []) as ManagedRole[];
  }

  async rename(id: number, name: string, actorUserId: number): Promise<ManagedRole> {
    const { data, error } = await this.client.rpc("rename_reserved_role", {
      p_role_id: id, p_name: name, p_actor_user_id: actorUserId, p_source: "taxonomy_admin_api",
    }).single();
    if (error) throw governanceDatabaseError("Unable to rename role", error);
    return data as ManagedRole;
  }
}
