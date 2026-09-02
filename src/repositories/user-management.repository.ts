import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, DatabaseError, type DatabaseDiagnostic } from "../errors.js";
import type { NormalizedUser } from "../identity/types.js";
import type { AccessUpdate, BusinessUserCodeUpdate, ManagedUser, UserManagementStatus } from "../user-management/types.js";

interface ManagedUserRow extends NormalizedUser {
  divisions: ManagedUser["division"];
  roles: ManagedUser["role"];
  user_channels: Array<{ channel_type: string; active: boolean }>;
}

export interface UserManagementRepository {
  findAll(status?: UserManagementStatus): Promise<ManagedUser[]>;
  findById(id: number): Promise<ManagedUser | null>;
  findNormalizedByLegacyId(legacyId: number): Promise<ManagedUser | null>;
  updateAccess(id: number, update: AccessUpdate, source: string, actorUserId?: number | null): Promise<ManagedUser>;
  updateBusinessUserCode(id: number, update: BusinessUserCodeUpdate, source: string, actorUserId: number): Promise<ManagedUser>;
}

const selection = "id,display_name,business_user_code,division_id,role_id,active,legacy_telegram_user_id,created_at,updated_at,divisions(id,code,name,active,created_at,updated_at),roles(id,code,name,active,created_at,updated_at),user_channels(channel_type,active)";
const legacySelection = "id,display_name,division_id,role_id,active,legacy_telegram_user_id,created_at,updated_at,divisions(id,code,name,active,created_at,updated_at),roles(id,code,name,active,created_at,updated_at),user_channels(channel_type,active)";
const missingBusinessCodeColumn = (error: DatabaseDiagnostic | null): boolean => ["PGRST204", "42703"].includes(error?.code ?? "");

function databaseError(message: string, error: DatabaseDiagnostic): Error {
  if (error.code === "23503" || error.code === "23514" || error.code === "22023") {
    return new AppError(400, "VALIDATION_ERROR", error.message ?? message);
  }
  if (error.code === "23505") return new AppError(409, "BUSINESS_USER_CODE_DUPLICATE", "Business user code is already assigned");
  if (error.code === "42501") return new AppError(403, "BUSINESS_USER_CODE_FORBIDDEN", "Active IT SYSTEM_ADMIN authority is required");
  if (error.code === "P0002") return new AppError(404, "NOT_FOUND", error.message ?? message);
  if (error.code === "P0001") return new AppError(409, "GOVERNANCE_INVARIANT", error.message ?? message);
  return new DatabaseError(message, error);
}

function toManagedUser(row: ManagedUserRow): ManagedUser {
  return {
    id: row.id,
    display_name: row.display_name,
    business_user_code: row.business_user_code ?? null,
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
    let { data, error } = await this.client.from("users").select(selection).order("created_at", { ascending: false });
    if (missingBusinessCodeColumn(error)) {
      const fallback = await this.client.from("users").select(legacySelection).order("created_at", { ascending: false });
      data = fallback.data as typeof data; error = fallback.error;
    }
    if (error) throw databaseError("Unable to load normalized users", error);
    return ((data ?? []) as unknown as ManagedUserRow[]).map(toManagedUser).filter((user) => hasStatus(user, status));
  }

  async findById(id: number): Promise<ManagedUser | null> {
    let { data, error } = await this.client.from("users").select(selection).eq("id", id).maybeSingle();
    if (missingBusinessCodeColumn(error)) {
      const fallback = await this.client.from("users").select(legacySelection).eq("id", id).maybeSingle();
      data = fallback.data as typeof data; error = fallback.error;
    }
    if (error) throw databaseError("Unable to load normalized user", error);
    return data ? toManagedUser(data as unknown as ManagedUserRow) : null;
  }

  async findNormalizedByLegacyId(legacyId: number): Promise<ManagedUser | null> {
    let { data, error } = await this.client
      .from("users").select(selection).eq("legacy_telegram_user_id", legacyId).maybeSingle();
    if (missingBusinessCodeColumn(error)) {
      const fallback = await this.client.from("users").select(legacySelection).eq("legacy_telegram_user_id", legacyId).maybeSingle();
      data = fallback.data as typeof data; error = fallback.error;
    }
    if (error) throw databaseError("Unable to load normalized user", error);
    return data ? toManagedUser(data as unknown as ManagedUserRow) : null;
  }

  async updateAccess(id: number, update: AccessUpdate, source: string, actorUserId: number | null = null): Promise<ManagedUser> {
    const { error } = await this.client.rpc("update_user_access", {
      p_user_id: id,
      p_division_id: update.division_id,
      p_role_id: update.role_id,
      p_active: update.active,
      p_actor_user_id: actorUserId,
      p_source: source,
    }).single();
    if (error) throw databaseError("Unable to update user access", error);
    const user = await this.findById(id);
    if (!user) throw new AppError(404, "NOT_FOUND", "Normalized user not found");
    return user;
  }

  async updateBusinessUserCode(id: number, update: BusinessUserCodeUpdate, source: string, actorUserId: number): Promise<ManagedUser> {
    const { error } = await this.client.rpc("update_business_user_code", {
      p_user_id: id,
      p_business_user_code: update.business_user_code,
      p_confirm_change: update.confirm_change,
      p_actor_user_id: actorUserId,
      p_source: source,
    }).single();
    if (error) throw databaseError("Unable to update business user code", error);
    const user = await this.findById(id);
    if (!user) throw new AppError(404, "NOT_FOUND", "Normalized user not found");
    return user;
  }
}
