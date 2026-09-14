import { randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import { hashPassword, validatePasswordPolicy } from "../auth/admin-password.js";
import { mapLegacyDivision, mapLegacyRole } from "../identity/legacy-mapping.js";
import { normalizeBusinessUserCode } from "../identity/business-user-code.js";
import type { DivisionsRepository } from "../repositories/divisions.repository.js";
import type { RolesRepository } from "../repositories/roles.repository.js";
import type { UserManagementRepository } from "../repositories/user-management.repository.js";
import type {
  AccessUpdate,
  AdminUserDto,
  BusinessUserCodeUpdate,
  ManagedDivision,
  ManagedUser,
  UserListFilters,
  UserManagementCatalogs,
  UserManagementStatus,
} from "../user-management/types.js";
import type { UserUpdate } from "../types/index.js";
import type { SystemAuthorityService } from "./system-authority.service.js";

const EMAIL_PATTERN = /^[^@\s\p{Cc}]+@[^@.\s\p{Cc}]+(?:\.[^@.\s\p{Cc}]+)+$/u;

function normalizedEmail(emailInput: unknown): string {
  const email = typeof emailInput === "string" ? emailInput.trim().toLocaleLowerCase("en-US") : "";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AppError(400, "VALIDATION_ERROR", "Email address is invalid");
  }
  return email;
}

function normalizedIdentity(displayNameInput: unknown, emailInput: unknown): { displayName: string; email: string } {
  const displayName = typeof displayNameInput === "string" ? displayNameInput.trim() : "";
  if (!displayName || displayName.length > 120 || /[\p{Cc}]/u.test(displayName)) {
    throw new AppError(400, "VALIDATION_ERROR", "Display name must contain 1-120 characters and no control characters");
  }
  return { displayName, email: normalizedEmail(emailInput) };
}

function normalizedReason(input: unknown): string {
  const reason = typeof input === "string" ? input.trim() : "";
  if (!reason || reason.length > 500 || /[\p{Cc}]/u.test(reason)) {
    throw new AppError(400, "VALIDATION_ERROR", "Reason must contain 1-500 characters");
  }
  return reason;
}

export function generateTemporaryPassword(context: { email: string; displayName: string }): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const password = randomBytes(24).toString("base64url");
    try { validatePasswordPolicy(password, context); return password; } catch { /* regenerate */ }
  }
  throw new AppError(500, "TEMPORARY_PASSWORD_GENERATION_FAILED", "Unable to generate temporary password");
}

interface CursorPayload { v: 1; created_at: string; id: number }

function decodeCursor(cursor: string | undefined): Pick<UserListFilters, "cursor_created_at" | "cursor_id"> {
  if (!cursor) return {};
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new AppError(400, "VALIDATION_ERROR", "Cursor is invalid");
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (value.v !== 1 || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))
      || !Number.isSafeInteger(value.id) || value.id! < 1 || Object.keys(value).sort().join(",") !== "created_at,id,v") {
      throw new Error("invalid");
    }
    return { cursor_created_at: value.created_at, cursor_id: value.id };
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Cursor is invalid");
  }
}

function encodeCursor(user: ManagedUser): string {
  return Buffer.from(JSON.stringify({ v: 1, created_at: user.created_at, id: user.id } satisfies CursorPayload), "utf8").toString("base64url");
}

export function toAdminUserDto(user: ManagedUser, actorUserId: number): AdminUserDto {
  return {
    id: user.id, display_name: user.display_name, email: user.email ?? null,
    business_user_code: user.business_user_code,
    division: user.division ? { id: user.division.id, code: user.division.code, name: user.division.name,
      active: user.division.active, grants_system_authority: user.division.grants_system_authority === true } : null,
    role: user.role ? { id: user.role.id, code: user.role.code, name: user.role.name, active: user.role.active } : null,
    active: user.active, telegram_connected: user.telegram_connected, has_login: user.has_login === true,
    password_change_required: user.password_change_required === true, system_admin: user.system_admin === true,
    effective_system_admin: user.effective_system_admin === true, is_current_user: user.id === actorUserId,
    created_at: user.created_at, updated_at: user.updated_at,
  };
}

export class UserManagementService {
  constructor(
    private readonly users: UserManagementRepository,
    private readonly divisions: DivisionsRepository,
    private readonly roles: RolesRepository,
    private readonly authorities?: SystemAuthorityService,
  ) {}

  list(status?: UserManagementStatus): Promise<ManagedUser[]> {
    return this.users.findAll(status);
  }

  async listPage(input: Omit<UserListFilters, "cursor_created_at" | "cursor_id"> & { cursor?: string }, actorUserId: number) {
    const filters: UserListFilters = { ...input, ...decodeCursor(input.cursor) };
    if (this.users.findPage) {
      const page = await this.users.findPage(filters, actorUserId);
      return { data: page.users.map((user) => toAdminUserDto(user, actorUserId)),
        nextCursor: page.hasMore && page.users.length ? encodeCursor(page.users.at(-1)!) : null };
    }
    let values = await this.users.findAll(filters.status);
    const q = filters.q?.toLocaleLowerCase("en-US");
    if (q) values = values.filter((user) => [user.display_name, user.email, user.business_user_code]
      .some((value) => value?.toLocaleLowerCase("en-US").includes(q)));
    if (filters.division_id !== undefined) values = values.filter((user) => user.division?.id === filters.division_id);
    if (filters.system_admin !== undefined) values = values.filter((user) => user.system_admin === filters.system_admin);
    if (filters.has_login !== undefined) values = values.filter((user) => user.has_login === filters.has_login);
    values.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
    if (filters.cursor_created_at && filters.cursor_id) values = values.filter((user) =>
      user.created_at < filters.cursor_created_at! || (user.created_at === filters.cursor_created_at && user.id < filters.cursor_id!));
    const page = values.slice(0, filters.limit);
    return { data: page.map((user) => toAdminUserDto(user, actorUserId)),
      nextCursor: values.length > filters.limit && page.length ? encodeCursor(page.at(-1)!) : null };
  }

  async get(id: number): Promise<ManagedUser> {
    const user = await this.users.findById(id);
    if (!user) throw new AppError(404, "NOT_FOUND", "Normalized user not found");
    return user;
  }

  async getDto(id: number, actorUserId: number): Promise<AdminUserDto> {
    return toAdminUserDto(await this.get(id), actorUserId);
  }

  async catalogs(): Promise<UserManagementCatalogs> {
    const [divisions, roles] = await Promise.all([
      this.divisions.findAll({ activeOnly: true }),
      this.roles.findAll({ activeOnly: true }),
    ]);
    return { divisions, roles };
  }

  async updateAccess(id: number, update: AccessUpdate, source = "admin_api_shared_key", actorUserId: number | null = null,
    guard: { confirm?: boolean; reason?: unknown } = {}): Promise<ManagedUser> {
    const current = await this.get(id);
    const division = update.division_id === null ? null : (await this.divisions.findAll()).find((item) => item.id === update.division_id) as ManagedDivision | undefined;
    const role = update.role_id === null ? null : (await this.roles.findAll()).find((item) => item.id === update.role_id);
    if (update.division_id !== null && !division) throw new AppError(400, "VALIDATION_ERROR", "Division not found");
    if (update.role_id !== null && !role) throw new AppError(400, "VALIDATION_ERROR", "Role not found");
    if (division && current.division?.id !== division.id && !division.active) {
      throw new AppError(400, "VALIDATION_ERROR", "Disabled division cannot be newly assigned");
    }
    if (role && current.role?.id !== role.id && !role.active) {
      throw new AppError(400, "VALIDATION_ERROR", "Disabled role cannot be newly assigned");
    }
    if (update.active && (!division || !role)) {
      throw new AppError(400, "VALIDATION_ERROR", "Active user requires a division and role");
    }
    if (actorUserId === id && !update.active) {
      throw new AppError(403, "SELF_DEACTIVATION_FORBIDDEN", "You cannot deactivate your own account");
    }
    if (actorUserId === id && current.effective_system_admin === true
      && (!division || !division.active || division.grants_system_authority !== true)) {
      if (guard.confirm !== true || typeof guard.reason !== "string" || guard.reason.trim().length < 1) {
        throw new AppError(409, "SELF_DEMOTION_CONFIRMATION_REQUIRED", "Self-demotion requires confirmation and a reason");
      }
    }
    const reason = guard.reason === undefined || guard.reason === null ? null : normalizedReason(guard.reason);
    return this.users.updateAccess(id, update, source, actorUserId, { confirm: guard.confirm, reason });
  }

  async updateProfile(id: number, displayNameInput: unknown, actorUserId: number): Promise<ManagedUser> {
    if (!this.users.updateProfile) throw new AppError(503, "USER_MANAGEMENT_UNAVAILABLE", "Profile management is unavailable");
    const current = await this.get(id);
    const identity = normalizedIdentity(displayNameInput, current.email ?? "placeholder@example.test");
    return this.users.updateProfile(id, identity.displayName, actorUserId);
  }

  async createAdministrator(input: { displayName: unknown; email: unknown; divisionId: number; roleId: number;
    grantSystemAdmin: boolean; reason: unknown }, actorUserId: number) {
    if (!this.users.createAdministrator) throw new AppError(503, "USER_MANAGEMENT_UNAVAILABLE", "Administrator creation is unavailable");
    const identity = normalizedIdentity(input.displayName, input.email);
    const reason = normalizedReason(input.reason);
    const password = generateTemporaryPassword({ email: identity.email, displayName: identity.displayName });
    const passwordHash = await hashPassword(password);
    const user = await this.users.createAdministrator({ ...identity, divisionId: input.divisionId, roleId: input.roleId,
      grantSystemAdmin: input.grantSystemAdmin, reason, passwordAlgorithm: "scrypt", passwordHash, actorUserId });
    return { user: toAdminUserDto(user, actorUserId), temporaryPassword: password };
  }

  async grantLogin(id: number, input: { email: unknown; reason: unknown }, actorUserId: number) {
    if (!this.users.grantLogin) throw new AppError(503, "USER_MANAGEMENT_UNAVAILABLE", "Login management is unavailable");
    const current = await this.get(id);
    if (!current.active) throw new AppError(409, "GOVERNANCE_INVARIANT", "Login can be granted only to an active user");
    const email = normalizedEmail(input.email);
    const reason = normalizedReason(input.reason);
    const password = generateTemporaryPassword({ email, displayName: current.display_name ?? "" });
    const passwordHash = await hashPassword(password);
    const user = await this.users.grantLogin({ userId: id, email, reason,
      passwordAlgorithm: "scrypt", passwordHash, actorUserId });
    return { user: toAdminUserDto(user, actorUserId), temporaryPassword: password };
  }

  async grantSystemAdmin(id: number, reasonInput: unknown, actorUserId: number): Promise<AdminUserDto> {
    if (!this.authorities) throw new AppError(503, "SYSTEM_AUTHORITY_UNAVAILABLE", "System authority management is unavailable");
    await this.authorities.assign(id, normalizedReason(reasonInput), actorUserId);
    return this.getDto(id, actorUserId);
  }

  async revokeSystemAdmin(id: number, reasonInput: unknown, confirm: boolean, actorUserId: number): Promise<AdminUserDto> {
    if (confirm !== true) throw new AppError(409, "SELF_DEMOTION_CONFIRMATION_REQUIRED", "Authority revocation requires confirmation");
    if (!this.authorities) throw new AppError(503, "SYSTEM_AUTHORITY_UNAVAILABLE", "System authority management is unavailable");
    await this.authorities.revoke(id, normalizedReason(reasonInput), actorUserId);
    return this.getDto(id, actorUserId);
  }

  async authoritySummary(actorUserId: number): Promise<{ effective_system_admins: number; you_are_last: boolean }> {
    if (!this.authorities) throw new AppError(503, "SYSTEM_AUTHORITY_UNAVAILABLE", "System authority management is unavailable");
    const status = await this.authorities.status();
    return { effective_system_admins: status.active_count, you_are_last: status.active_count === 1
      && (await this.get(actorUserId)).effective_system_admin === true };
  }

  async updateBusinessUserCode(id: number, update: BusinessUserCodeUpdate, source: string, actorUserId: number): Promise<ManagedUser> {
    const current = await this.get(id);
    const normalized = update.business_user_code === null ? null : normalizeBusinessUserCode(update.business_user_code);
    if (current.business_user_code !== null && current.business_user_code !== normalized && !update.confirm_change) {
      throw new AppError(409, "BUSINESS_USER_CODE_CONFIRMATION_REQUIRED", "Changing an existing business user code requires explicit confirmation");
    }
    return this.users.updateBusinessUserCode(id, {
      business_user_code: normalized,
      confirm_change: update.confirm_change,
    }, source, actorUserId);
  }

  async updateLegacyAccess(legacyId: number, update: UserUpdate, actorUserId: number): Promise<void> {
    const user = await this.users.findNormalizedByLegacyId(legacyId);
    if (!user) throw new AppError(404, "NOT_FOUND", "Normalized user not found for legacy user");
    let divisionId = user.division?.id ?? null;
    let roleId = user.role?.id ?? null;
    if (update.division !== undefined) {
      const value = update.division.trim();
      const catalog = await this.divisions.findAll();
      const normalized = catalog.find((item) => item.name === value || item.code === value.toUpperCase());
      const fallbackCode = normalized ? undefined : mapLegacyDivision(value);
      if (!normalized && fallbackCode === undefined) throw new AppError(400, "VALIDATION_ERROR", "Invalid division");
      divisionId = normalized?.id ?? (fallbackCode === null ? null : (await this.divisions.findByCode(fallbackCode!))?.id ?? null);
      if (fallbackCode !== null && divisionId === null) throw new AppError(400, "VALIDATION_ERROR", "Division not found");
    }
    if (update.role !== undefined) {
      const value = update.role.trim();
      const catalog = await this.roles.findAll();
      const normalized = catalog.find((item) => item.name === value || item.code === value.toUpperCase());
      const fallbackCode = normalized ? undefined : mapLegacyRole(value);
      if (!normalized && fallbackCode === undefined) throw new AppError(400, "VALIDATION_ERROR", "Invalid role");
      roleId = normalized?.id ?? (fallbackCode === null ? null : (await this.roles.findByCode(fallbackCode!))?.id ?? null);
      if (fallbackCode !== null && roleId === null) throw new AppError(400, "VALIDATION_ERROR", "Role not found");
    }
    await this.updateAccess(user.id, {
      division_id: divisionId,
      role_id: roleId,
      active: update.active ?? user.active,
    }, "legacy_admin_api_compatibility", actorUserId);
  }
}
