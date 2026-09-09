import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminDivision, Division } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface DivisionsRepository {
  findAll(options?: { activeOnly?: boolean }): Promise<Division[]>;
  findByCode(code: string): Promise<Division | null>;
  create(input: { code: string; name: string }): Promise<Division>;
  findAdminCatalog?(options?: { activeOnly?: boolean }): Promise<AdminDivision[]>;
  createManaged?(input: { code: string; name: string; actorUserId: number }): Promise<AdminDivision>;
  updateManaged?(id: number, input: { name?: string; active?: boolean; actorUserId: number }): Promise<AdminDivision>;
  deleteManaged?(id: number, actorUserId: number): Promise<AdminDivision>;
}

export class SupabaseDivisionsRepository implements DivisionsRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findAll(options: { activeOnly?: boolean } = {}): Promise<Division[]> {
    let query = this.client.from("divisions").select("*").order("name", { ascending: true });
    if (options.activeOnly) query = query.eq("active", true);
    const { data, error } = await query;
    if (error) throw governanceDatabaseError("Unable to load divisions", error);
    return (data ?? []) as Division[];
  }

  async findByCode(code: string): Promise<Division | null> {
    const { data, error } = await this.client.from("divisions").select("*").eq("code", code).maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load division", error);
    return data as Division | null;
  }

  async create(input: { code: string; name: string }): Promise<Division> {
    const { data, error } = await this.client.from("divisions").insert(input).select("*").single();
    if (error) throw governanceDatabaseError("Unable to create division", error);
    return data as Division;
  }

  async findAdminCatalog(options: { activeOnly?: boolean } = {}): Promise<AdminDivision[]> {
    let query = this.client.from("divisions").select("*").order("name", { ascending: true });
    if (options.activeOnly) query = query.eq("active", true);
    const { data, error } = await query;
    if (error) throw governanceDatabaseError("Unable to load division catalog", error);
    return (data ?? []) as AdminDivision[];
  }

  async createManaged(input: { code: string; name: string; actorUserId: number }): Promise<AdminDivision> {
    const { data, error } = await this.client.rpc("create_customer_division", {
      p_code: input.code, p_name: input.name, p_actor_user_id: input.actorUserId, p_source: "taxonomy_admin_api",
    }).single();
    if (error) throw governanceDatabaseError("Unable to create division", error);
    return data as AdminDivision;
  }

  async updateManaged(id: number, input: { name?: string; active?: boolean; actorUserId: number }): Promise<AdminDivision> {
    const { data, error } = await this.client.rpc("update_customer_division", {
      p_division_id: id, p_name: input.name ?? null, p_active: input.active ?? null,
      p_actor_user_id: input.actorUserId, p_source: "taxonomy_admin_api",
    }).single();
    if (error) throw governanceDatabaseError("Unable to update division", error);
    return data as AdminDivision;
  }

  async deleteManaged(id: number, actorUserId: number): Promise<AdminDivision> {
    const { data, error } = await this.client.rpc("delete_customer_division", {
      p_division_id: id, p_actor_user_id: actorUserId, p_source: "taxonomy_admin_api",
    }).single();
    if (error) throw governanceDatabaseError("Unable to delete division", error);
    return data as AdminDivision;
  }
}
