import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface RolesRepository {
  findAll(options?: { activeOnly?: boolean }): Promise<Role[]>;
  findByCode(code: string): Promise<Role | null>;
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
}
