import { AppError } from "../errors.js";
import { mapLegacyDivision, mapLegacyRole } from "../identity/legacy-mapping.js";
import { normalizeBusinessUserCode } from "../identity/business-user-code.js";
import type { DivisionsRepository } from "../repositories/divisions.repository.js";
import type { RolesRepository } from "../repositories/roles.repository.js";
import type { UserManagementRepository } from "../repositories/user-management.repository.js";
import type { AccessUpdate, BusinessUserCodeUpdate, ManagedUser, UserManagementCatalogs, UserManagementStatus } from "../user-management/types.js";
import type { UserUpdate } from "../types/index.js";

export class UserManagementService {
  constructor(
    private readonly users: UserManagementRepository,
    private readonly divisions: DivisionsRepository,
    private readonly roles: RolesRepository,
  ) {}

  list(status?: UserManagementStatus): Promise<ManagedUser[]> {
    return this.users.findAll(status);
  }

  async get(id: number): Promise<ManagedUser> {
    const user = await this.users.findById(id);
    if (!user) throw new AppError(404, "NOT_FOUND", "Normalized user not found");
    return user;
  }

  async catalogs(): Promise<UserManagementCatalogs> {
    const [divisions, roles] = await Promise.all([
      this.divisions.findAll({ activeOnly: true }),
      this.roles.findAll({ activeOnly: true }),
    ]);
    return { divisions, roles };
  }

  async updateAccess(id: number, update: AccessUpdate, source = "admin_api_shared_key", actorUserId: number | null = null): Promise<ManagedUser> {
    const current = await this.get(id);
    const division = update.division_id === null ? null : (await this.divisions.findAll()).find((item) => item.id === update.division_id);
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
    return this.users.updateAccess(id, update, source, actorUserId);
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

  async updateLegacyAccess(legacyId: number, update: UserUpdate): Promise<void> {
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
    }, "legacy_admin_api_compatibility");
  }
}
