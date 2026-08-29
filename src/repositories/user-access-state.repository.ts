import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserAccessSnapshot } from "../identity/user-access-state.js";
import { governanceDatabaseError } from "./governance-database-error.js";

interface UserAccessRow {
  active: boolean;
  division_id: number | null;
  role_id: number | null;
  divisions: { code: string } | null;
  roles: { code: string } | null;
}

export interface UserAccessStateRepository {
  findByLegacyTelegramUserId(legacyUserId: number): Promise<UserAccessSnapshot | null>;
}

export class SupabaseUserAccessStateRepository implements UserAccessStateRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findByLegacyTelegramUserId(legacyUserId: number): Promise<UserAccessSnapshot | null> {
    const { data, error } = await this.client
      .from("users")
      .select("active,division_id,role_id,divisions(code),roles(code)")
      .eq("legacy_telegram_user_id", legacyUserId)
      .maybeSingle();
    if (error) throw governanceDatabaseError("Unable to load final normalized access state", error);
    if (!data) return null;
    const row = data as unknown as UserAccessRow;
    return {
      active: row.active,
      divisionId: row.division_id,
      roleId: row.role_id,
      divisionCode: row.divisions?.code ?? null,
      roleCode: row.roles?.code ?? null,
    };
  }
}
