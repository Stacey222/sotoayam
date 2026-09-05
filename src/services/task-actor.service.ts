import { AppError } from "../errors.js";
import type { PermissionsRepository } from "../repositories/permissions.repository.js";
import type { SystemAuthorityRepository } from "../repositories/system-authority.repository.js";
import type { TaskUsersRepository } from "../repositories/task-users.repository.js";
import type { UserChannelsRepository } from "../repositories/user-channels.repository.js";
import type { TaskActor } from "../tasks/types.js";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TaskActorResolver { resolveTrustedActor(authorization?: string): Promise<TaskActor> }
export interface TelegramTaskActorResolver { resolveTelegramActor(externalTelegramId: number): Promise<TaskActor> }
export interface OwnerActorResolver { resolveOwnerActor(authorization?: string): Promise<TaskActor> }

export interface HumanSessionVerifier { verify(accessToken: string): Promise<number> }

export class SupabaseHumanSessionVerifier implements HumanSessionVerifier {
  constructor(private readonly client: SupabaseClient) {}

  async verify(accessToken: string): Promise<number> {
    const { data, error } = await this.client.auth.getUser(accessToken);
    if (error || !data.user) throw new AppError(401, "AUTHENTICATION_INVALID", "The user session is invalid or expired");
    const userId = data.user.app_metadata?.gwens_user_id;
    if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) {
      throw new AppError(403, "AUTHENTICATED_USER_UNMAPPED", "The authenticated identity is not mapped to a Gwens user");
    }
    return userId;
  }
}

export class AuthenticatedTaskActorService implements TaskActorResolver {
  constructor(
    private readonly sessions: HumanSessionVerifier,
    private readonly users: TaskUsersRepository,
    private readonly permissions: PermissionsRepository,
    private readonly authorities?: SystemAuthorityRepository,
  ) {}

  async resolveTrustedActor(authorization?: string): Promise<TaskActor> {
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
    if (!match) throw new AppError(401, "AUTHENTICATION_REQUIRED", "A Bearer user session is required");
    const userId = await this.sessions.verify(match[1]!);
    const user = await this.users.findById(userId);
    if (!user) throw new AppError(403, "AUTHENTICATED_USER_UNMAPPED", "The authenticated identity is not mapped to a Gwens user");
    if (!user.active || user.divisionId === null || user.roleId === null || !user.roleCode) {
      throw new AppError(403, "AUTHENTICATED_USER_INACTIVE", "An active normalized business identity is required");
    }
    if (this.authorities && (user.divisionCode !== "IT" || !await this.authorities.findActiveForUser(user.id))) {
      throw new AppError(403, "SYSTEM_AUTHORITY_REQUIRED", "Active IT SYSTEM_ADMIN authority is required");
    }
    const permissions = await this.permissions.findForRoleCode(user.roleCode);
    return { ...user, permissions: new Set(permissions.filter((item) => item.active).map((item) => item.code)) };
  }
}

export class AuthenticatedOwnerActorService implements OwnerActorResolver {
  constructor(private readonly actors: TaskActorResolver) {}
  async resolveOwnerActor(authorization?: string): Promise<TaskActor> {
    const actor = await this.actors.resolveTrustedActor(authorization);
    if (actor.roleCode !== "OWNER") throw new AppError(403, "OWNER_AUTHORITY_REQUIRED", "Active OWNER authority is required");
    return actor;
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
