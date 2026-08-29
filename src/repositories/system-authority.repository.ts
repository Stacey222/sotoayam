import type { SupabaseClient } from "@supabase/supabase-js";
import type { SystemAuthorityAssignment } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface SystemAuthorityRepository {
  findActiveForUser(userId: number): Promise<SystemAuthorityAssignment | null>;
}

export class SupabaseSystemAuthorityRepository implements SystemAuthorityRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findActiveForUser(userId: number): Promise<SystemAuthorityAssignment | null> {
    const { data, error } = await this.client
      .from("system_authority_assignments")
      .select("*")
      .eq("user_id", userId)
      .eq("authority_code", "SYSTEM_ADMIN")
      .is("revoked_at", null)
      .maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load system authority", error);
    return data as SystemAuthorityAssignment | null;
  }
}
