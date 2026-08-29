import type { SupabaseClient } from "@supabase/supabase-js";
import type { Division } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface DivisionsRepository {
  findAll(options?: { activeOnly?: boolean }): Promise<Division[]>;
  findByCode(code: string): Promise<Division | null>;
  create(input: { code: string; name: string }): Promise<Division>;
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
}
