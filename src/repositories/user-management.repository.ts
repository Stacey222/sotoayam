import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, DatabaseError, type DatabaseDiagnostic } from "../errors.js";
import type { NormalizedUser } from "../identity/types.js";
import type {
  AccessUpdate,
  AdministratorCredentialInput,
  BusinessUserCodeUpdate,
  LoginCredentialInput,
  ManagedUser,
  ManagedUserPage,
  UserListFilters,
  UserManagementStatus,
} from "../user-management/types.js";

interface ManagedUserRow extends NormalizedUser {
  divisions: ManagedUser["division"];
  roles: ManagedUser["role"];
  user_channels: Array<{ channel_type: string; active: boolean }>;
  admin_credentials?: { email: string; password_change_required: boolean } | Array<{ email: string; password_change_required: boolean }> | null;
  system_authority_assignments?: Array<{ authority_code: string; revoked_at: string | null }>;
}

interface ManagedUserRpcRow {
  user_id: number;
  display_name: string | null;
  email: string | null;
  business_user_code: string | null;
  division_id: number | null;
  division_code: string | null;
  division_name: string | null;
  division_active: boolean | null;
  division_grants_system_authority: boolean | null;
  role_id: number | null;
  role_code: string | null;
  role_name: string | null;
  role_active: boolean | null;
  user_active: boolean;
  telegram_connected: boolean;
  has_login: boolean;
  password_change_required: boolean;
  system_admin: boolean;
  effective_system_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserManagementRepository {
  findAll(status?: UserManagementStatus): Promise<ManagedUser[]>;
  findPage?(filters: UserListFilters, actorUserId: number): Promise<ManagedUserPage>;
  findById(id: number): Promise<ManagedUser | null>;
  findNormalizedByLegacyId(legacyId: number): Promise<ManagedUser | null>;
  updateAccess(id: number, update: AccessUpdate, source: string, actorUserId?: number | null,
    guard?: { confirm?: boolean; reason?: string | null }): Promise<ManagedUser>;
  updateBusinessUserCode(id: number, update: BusinessUserCodeUpdate, source: string, actorUserId: number): Promise<ManagedUser>;
  createAdministrator?(input: AdministratorCredentialInput): Promise<ManagedUser>;
  grantLogin?(input: LoginCredentialInput): Promise<ManagedUser>;
  updateProfile?(id: number, displayName: string, actorUserId: number): Promise<ManagedUser>;
}

const selection = "id,display_name,business_user_code,division_id,role_id,active,legacy_telegram_user_id,created_at,updated_at,divisions(id,code,name,active,grants_system_authority,provisioning_source,created_at,updated_at),roles(id,code,name,active,created_at,updated_at),user_channels(channel_type,active),admin_credentials(email,password_change_required),system_authority_assignments(authority_code,revoked_at)";
const legacySelection = "id,display_name,division_id,role_id,active,legacy_telegram_user_id,created_at,updated_at,divisions(id,code,name,active,grants_system_authority,provisioning_source,created_at,updated_at),roles(id,code,name,active,created_at,updated_at),user_channels(channel_type,active)";
const missingBusinessCodeColumn = (error: DatabaseDiagnostic | null): boolean => ["PGRST204", "42703"].includes(error?.code ?? "");

function databaseError(message: string, error: DatabaseDiagnostic): Error {
  if (error.code === "23503" || error.code === "23514" || error.code === "22023") {
    return new AppError(400, "VALIDATION_ERROR", error.message ?? message);
  }
  if (error.code === "23505") {
    if (error.message?.includes("admin_credentials_pkey")) {
      return new AppError(409, "LOGIN_ALREADY_ENABLED", "User already has login access");
    }
    if (error.message?.includes("admin_credentials") || error.message?.includes("email")) {
      return new AppError(409, "EMAIL_ALREADY_IN_USE", "Email address is already in use");
    }
    return new AppError(409, "BUSINESS_USER_CODE_DUPLICATE", "Business user code is already assigned");
  }
  if (error.code === "42501") {
    if (error.message?.includes("SELF_DEACTIVATION_FORBIDDEN")) {
      return new AppError(403, "SELF_DEACTIVATION_FORBIDDEN", "You cannot deactivate your own account");
    }
    return new AppError(403, "BUSINESS_USER_CODE_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
  }
  if (error.code === "P0002") return new AppError(404, "NOT_FOUND", error.message ?? message);
  if (error.code === "P0001") {
    if (error.message?.includes("LOGIN_ALREADY_ENABLED")) return new AppError(409, "LOGIN_ALREADY_ENABLED", "User already has login access");
    if (error.message?.includes("SELF_DEMOTION_CONFIRMATION_REQUIRED")) return new AppError(409,
      "SELF_DEMOTION_CONFIRMATION_REQUIRED", "Self-demotion requires confirmation and a reason");
    return new AppError(409,
      error.message?.includes("LAST_SYSTEM_ADMIN") ? "LAST_SYSTEM_ADMIN" : "GOVERNANCE_INVARIANT", error.message ?? message);
  }
  return new DatabaseError(message, error);
}

function relatedCredential(row: ManagedUserRow) {
  return Array.isArray(row.admin_credentials) ? row.admin_credentials[0] ?? null : row.admin_credentials ?? null;
}

function toManagedUser(row: ManagedUserRow): ManagedUser {
  const credential = relatedCredential(row);
  const systemAdmin = row.system_authority_assignments?.some((assignment) =>
    assignment.authority_code === "SYSTEM_ADMIN" && assignment.revoked_at === null) ?? false;
  const divisionEffective = row.divisions?.active === true && row.divisions.grants_system_authority === true;
  return {
    id: row.id,
    display_name: row.display_name,
    email: credential?.email ?? null,
    business_user_code: row.business_user_code ?? null,
    division: row.divisions,
    role: row.roles,
    active: row.active,
    telegram_connected: row.user_channels.some((channel) => channel.channel_type === "TELEGRAM" && channel.active),
    has_login: credential !== null,
    password_change_required: credential?.password_change_required === true,
    system_admin: systemAdmin,
    effective_system_admin: systemAdmin && row.active && divisionEffective,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function fromRpc(row: ManagedUserRpcRow): ManagedUser {
  return {
    id: Number(row.user_id), display_name: row.display_name, email: row.email,
    business_user_code: row.business_user_code,
    division: row.division_id === null ? null : {
      id: Number(row.division_id), code: row.division_code!, name: row.division_name!,
      active: row.division_active === true, grants_system_authority: row.division_grants_system_authority === true,
      created_at: "", updated_at: "",
    },
    role: row.role_id === null ? null : {
      id: Number(row.role_id), code: row.role_code!, name: row.role_name!, active: row.role_active === true,
      created_at: "", updated_at: "",
    },
    active: row.user_active, telegram_connected: row.telegram_connected, has_login: row.has_login,
    password_change_required: row.password_change_required, system_admin: row.system_admin,
    effective_system_admin: row.effective_system_admin, created_at: row.created_at, updated_at: row.updated_at,
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

  async findPage(filters: UserListFilters, actorUserId: number): Promise<ManagedUserPage> {
    const { data, error } = await this.client.rpc("list_managed_admin_users", {
      p_actor_user_id: actorUserId,
      p_q: filters.q ?? null,
      p_status: filters.status ?? null,
      p_division_id: filters.division_id ?? null,
      p_system_admin: filters.system_admin ?? null,
      p_has_login: filters.has_login ?? null,
      p_limit: filters.limit + 1,
      p_cursor_created_at: filters.cursor_created_at ?? null,
      p_cursor_id: filters.cursor_id ?? null,
    });
    if (error) throw databaseError("Unable to load administrator users", error);
    const rows = (data ?? []) as unknown as ManagedUserRpcRow[];
    return { users: rows.slice(0, filters.limit).map(fromRpc), hasMore: rows.length > filters.limit };
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

  async updateAccess(id: number, update: AccessUpdate, source: string, actorUserId: number | null = null,
    guard: { confirm?: boolean; reason?: string | null } = {}): Promise<ManagedUser> {
    const { error } = await this.client.rpc("update_managed_user_access", {
      p_user_id: id,
      p_division_id: update.division_id,
      p_role_id: update.role_id,
      p_active: update.active,
      p_actor_user_id: actorUserId,
      p_source: source,
      p_confirm: guard.confirm === true,
      p_reason: guard.reason ?? null,
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

  async createAdministrator(input: AdministratorCredentialInput): Promise<ManagedUser> {
    const { data, error } = await this.client.rpc("create_administrator_account", {
      p_display_name: input.displayName, p_email: input.email, p_division_id: input.divisionId,
      p_role_id: input.roleId, p_grant_system_admin: input.grantSystemAdmin, p_reason: input.reason,
      p_password_algorithm: input.passwordAlgorithm, p_password_hash: input.passwordHash,
      p_actor_user_id: input.actorUserId,
    });
    if (error) throw databaseError("Unable to create administrator account", error);
    const id = Number(Array.isArray(data) ? data[0]?.user_id : (data as { user_id?: unknown } | null)?.user_id ?? data);
    if (!Number.isSafeInteger(id) || id < 1) throw new DatabaseError("Administrator creation returned no user", {});
    const user = await this.findById(id);
    if (!user) throw new AppError(404, "NOT_FOUND", "Created administrator was not found");
    return user;
  }

  async grantLogin(input: LoginCredentialInput): Promise<ManagedUser> {
    const { error } = await this.client.rpc("grant_admin_login", {
      p_user_id: input.userId, p_email: input.email, p_reason: input.reason,
      p_password_algorithm: input.passwordAlgorithm, p_password_hash: input.passwordHash,
      p_actor_user_id: input.actorUserId,
    });
    if (error) throw databaseError("Unable to grant administrator login", error);
    const user = await this.findById(input.userId);
    if (!user) throw new AppError(404, "NOT_FOUND", "Updated administrator was not found");
    return user;
  }

  async updateProfile(id: number, displayName: string, actorUserId: number): Promise<ManagedUser> {
    const { error } = await this.client.rpc("update_admin_user_profile", {
      p_user_id: id, p_display_name: displayName, p_actor_user_id: actorUserId,
    });
    if (error) throw databaseError("Unable to update administrator profile", error);
    const user = await this.findById(id);
    if (!user) throw new AppError(404, "NOT_FOUND", "Updated administrator was not found");
    return user;
  }
}
