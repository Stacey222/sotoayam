import { AppError } from "../errors.js";
import type { PermissionsRepository } from "../repositories/permissions.repository.js";
import type { TaskUsersRepository } from "../repositories/task-users.repository.js";
import type { UserChannelsRepository } from "../repositories/user-channels.repository.js";
import type { TaskActor } from "../tasks/types.js";
import type { AdminPrincipal } from "../auth/admin-authorization.js";
import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";

export interface TaskActorResolver {
  resolveTrustedActor(): Promise<TaskActor>;
  resolveActor?(principal: AdminPrincipal): Promise<TaskActor>;
}
export interface TelegramTaskActorResolver { resolveTelegramActor(externalTelegramId: number): Promise<TaskActor> }
export interface OwnerActorResolver { resolveOwnerActor(): Promise<TaskActor> }

export class TrustedTaskActorService implements TaskActorResolver {
  constructor(private readonly users: TaskUsersRepository, private readonly permissions: PermissionsRepository) {}

  async resolveTrustedActor(): Promise<TaskActor> {
    const user = await this.users.findTrustedAdminActorUser();
    if (!user.active || user.divisionId === null || user.roleId === null || !user.roleCode) {
      throw new AppError(503, "TASK_ACTOR_UNAVAILABLE", "Trusted actor lacks active normalized business authorization");
    }
    const permissions = await this.permissions.findForRoleCode(user.roleCode);
    return { ...user, permissions: new Set(permissions.filter((item) => item.active).map((item) => item.code)) };
  }

  async resolveActor(principal: AdminPrincipal): Promise<TaskActor> {
    if (principal.kind === "shared-api-key") return this.resolveTrustedActor();
    const user = await this.users.findById(principal.adminUserId);
    if (!user?.active || user.divisionId === null || user.roleId === null || !user.roleCode
      || !hasSystemAdminCapability(user)
      || !this.users.hasActiveSystemAdminAuthority
      || !await this.users.hasActiveSystemAdminAuthority(user.id)) {
      throw new AppError(403, "ADMIN_AUTHORITY_REQUIRED", "Active SYSTEM_ADMIN authority is required");
    }
    const permissions = await this.permissions.findForRoleCode(user.roleCode);
    return { ...user, permissions: new Set(permissions.filter((item) => item.active).map((item) => item.code)) };
  }
}

export function resolveAdminActor(resolver: TaskActorResolver, principal: AdminPrincipal | null | undefined): Promise<TaskActor> {
  if (!principal) throw new AppError(401, "UNAUTHORIZED", "Administrator authentication is required");
  if (principal.kind === "session") {
    if (!resolver.resolveActor) throw new AppError(503, "TASK_ACTOR_UNAVAILABLE", "Session actor resolution is unavailable");
    return resolver.resolveActor(principal);
  }
  return resolver.resolveActor ? resolver.resolveActor(principal) : resolver.resolveTrustedActor();
}

export class TrustedOwnerActorService implements OwnerActorResolver {
  constructor(private readonly users: TaskUsersRepository, private readonly permissions: PermissionsRepository) {}
  async resolveOwnerActor(): Promise<TaskActor> {
    if (!this.users.findTrustedOwnerActorUser) throw new AppError(503, "OWNER_ACTOR_UNAVAILABLE", "Owner actor resolver is unavailable");
    const user = await this.users.findTrustedOwnerActorUser();
    if (!user.active || user.divisionId === null || user.roleId === null || user.roleCode !== "OWNER") {
      throw new AppError(503, "OWNER_ACTOR_UNAVAILABLE", "Active normalized OWNER authority is unavailable");
    }
    const permissions = await this.permissions.findForRoleCode(user.roleCode);
    return { ...user, permissions: new Set(permissions.filter((item) => item.active).map((item) => item.code)) };
  }
}

export class TelegramTaskActorService implements TelegramTaskActorResolver {
  constructor(
    private readonly channels: UserChannelsRepository,
    private readonly users: TaskUsersRepository,
    private readonly permissions: PermissionsRepository,
  ) {}

  async resolveTelegramActor(externalTelegramId: number): Promise<TaskActor> {
    if (!Number.isSafeInteger(externalTelegramId) || externalTelegramId <= 0) {
      throw new AppError(403, "TASK_FORBIDDEN", "Active normalized business identity is required");
    }
    const channel = await this.channels.findByExternalIdentity("TELEGRAM", String(externalTelegramId));
    if (!channel?.active) throw new AppError(403, "TASK_FORBIDDEN", "Active normalized business identity is required");
    const user = await this.users.findById(channel.user_id);
    if (!user?.active || user.divisionId === null || user.roleId === null || !user.roleCode) {
      throw new AppError(403, "TASK_FORBIDDEN", "Active normalized business identity is required");
    }
    const permissions = await this.permissions.findForRoleCode(user.roleCode);
    return { ...user, permissions: new Set(permissions.filter((item) => item.active).map((item) => item.code)) };
  }
}
