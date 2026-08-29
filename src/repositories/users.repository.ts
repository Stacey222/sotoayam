import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedUser } from "../identity/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface UsersRepository {
  findByLegacyTelegramUserId(legacyUserId: number): Promise<NormalizedUser | null>;
  countSystemAdminCandidates(): Promise<number>;
}

export class SupabaseUsersRepository implements UsersRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findByLegacyTelegramUserId(legacyUserId: number): Promise<NormalizedUser | null> {
    const { data, error } = await this.client
      .from("users")
      .select("*")
      .eq("legacy_telegram_user_id", legacyUserId)
      .maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load normalized user", error);
    return data as NormalizedUser | null;
  }

  async countSystemAdminCandidates(): Promise<number> {
    const { count, error } = await this.client
      .from("users")
      .select("id, divisions!inner(code)", { count: "exact", head: true })
      .eq("active", true)
      .eq("divisions.code", "IT");
    if (error) throw governanceDatabaseError("Unable to count system authority candidates", error);
    return count ?? 0;
  }
}
