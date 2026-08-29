import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, DatabaseError, type DatabaseDiagnostic } from "../errors.js";
import type { NormalizedUser } from "../identity/types.js";
import type { AccessUpdate, ManagedUser, UserManagementStatus } from "../user-management/types.js";

interface ManagedUserRow extends NormalizedUser {
  divisions: ManagedUser["division"];
  roles: ManagedUser["role"];
  user_channels: Array<{ channel_type: string; active: boolean }>;
}

export interface UserManagementRepository {
  findAll(status?: UserManagementStatus): Promise<ManagedUser[]>;
  findById(id: number): Promise<ManagedUser | null>;
  findNormalizedByLegacyId(legacyId: number): Promise<ManagedUser | null>;
  updateAccess(id: number, update: AccessUpdate, source: string): Promise<ManagedUser>;
}

const selection = "id,display_name,division_id,role_id,active,legacy_telegram_user_id,created_at,updated_at,divisions(id,code,name,active,created_at,updated_at),roles(id,code,name,active,created_at,updated_at),user_channels(channel_type,active)";

function databaseError(message: string, error: DatabaseDiagnostic): Error {
  if (error.code === "23503" || error.code === "23514" || error.code === "22023") {
    return new AppError(400, "VALIDATION_ERROR", error.message ?? message);
  }
  if (error.code === "P0002") return new AppError(404, "NOT_FOUND", error.message ?? message);
  if (error.code === "P0001") return new AppError(409, "GOVERNANCE_INVARIANT", error.message ?? message);
  return new DatabaseError(message, error);
}

function toManagedUser(row: ManagedUserRow): ManagedUser {
  return {
    id: row.id,
    display_name: row.display_name,
    division: row.divisions,
    role: row.roles,
    active: row.active,
    telegram_connected: row.user_channels.some((channel) => channel.channel_type === "TELEGRAM" && channel.active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hasStatus(user: ManagedUser, status?: UserManagementStatus): boolean {
  if (!status) return true;
  if (status === "active") return user.active;
  if (status === "pending") return !user.active && (!user.division || !user.role);
  return !user.active && Boolean(user.division && user.role);
}

export class SupabaseUserManagementRepository implements UserManagementRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findAll(status?: UserManagementStatus): Promise<ManagedUser[]> {
    const { data, error } = await this.client.from("users").select(selection).order("created_at", { ascending: false });
    if (error) throw databaseError("Unable to load normalized users", error);
    return ((data ?? []) as unknown as ManagedUserRow[]).map(toManagedUser).filter((user) => hasStatus(user, status));
  }

  async findById(id: number): Promise<ManagedUser | null> {
    const { data, error } = await this.client.from("users").select(selection).eq("id", id).maybeSingle();
    if (error) throw databaseError("Unable to load normalized user", error);
    return data ? toManagedUser(data as unknown as ManagedUserRow) : null;
  }

  async findNormalizedByLegacyId(legacyId: number): Promise<ManagedUser | null> {
    const { data, error } = await this.client
      .from("users").select(selection).eq("legacy_telegram_user_id", legacyId).maybeSingle();
    if (error) throw databaseError("Unable to load normalized user", error);
    return data ? toManagedUser(data as unknown as ManagedUserRow) : null;
  }

  async updateAccess(id: number, update: AccessUpdate, source: string): Promise<ManagedUser> {
    const { error } = await this.client.rpc("update_user_access", {
      p_user_id: id,
      p_division_id: update.division_id,
      p_role_id: update.role_id,
      p_active: update.active,
      p_actor_user_id: null,
      p_source: source,
    }).single();
    if (error) throw databaseError("Unable to update user access", error);
    const user = await this.findById(id);
    if (!user) throw new AppError(404, "NOT_FOUND", "Normalized user not found");
    return user;
  }
}
