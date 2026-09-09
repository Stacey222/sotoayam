import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminDivision, SystemAuthorityAssignment } from "../governance/types.js";
import { governanceDatabaseError } from "./governance-database-error.js";

export interface SystemAuthorityRepository {
  findActiveForUser(userId: number): Promise<SystemAuthorityAssignment | null>;
  countActive(): Promise<number>;
  assign(userId: number, reason: string): Promise<SystemAuthorityAssignment>;
  revoke(userId: number, reason: string): Promise<SystemAuthorityAssignment>;
  setDivisionCapability?(divisionId: number, enabled: boolean, actorUserId: number): Promise<AdminDivision>;
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

  async countActive(): Promise<number> {
    const { count, error } = await this.client.from("system_authority_assignments")
      .select("id", { count: "exact", head: true }).eq("authority_code", "SYSTEM_ADMIN").is("revoked_at", null);
    if (error) throw governanceDatabaseError("Unable to count active system authorities", error);
    return count ?? 0;
  }

  async assign(userId: number, reason: string): Promise<SystemAuthorityAssignment> {
    const { data, error } = await this.client.rpc("assign_system_admin", {
      p_user_id: userId, p_reason: reason, p_actor_user_id: null,
    }).single();
    if (error) throw governanceDatabaseError("Unable to assign SYSTEM_ADMIN", error);
    return data as SystemAuthorityAssignment;
  }

  async revoke(userId: number, reason: string): Promise<SystemAuthorityAssignment> {
    const { data, error } = await this.client.rpc("revoke_system_admin", {
      p_user_id: userId, p_reason: reason, p_actor_user_id: null,
    }).single();
    if (error) throw governanceDatabaseError("Unable to revoke SYSTEM_ADMIN", error);
    return data as SystemAuthorityAssignment;
  }

  async setDivisionCapability(divisionId: number, enabled: boolean, actorUserId: number): Promise<AdminDivision> {
    const { data, error } = await this.client.rpc("set_division_system_authority", {
      p_division_id: divisionId, p_enabled: enabled, p_actor_user_id: actorUserId, p_source: "system_authority_api",
    }).single();
    if (error) throw governanceDatabaseError("Unable to update division authority capability", error);
    return data as AdminDivision;
  }
}
