import { AppError } from "../errors.js";
import type { PermissionsRepository } from "../repositories/permissions.repository.js";
import type { TaskUsersRepository } from "../repositories/task-users.repository.js";
import type { TaskActor } from "../tasks/types.js";

export interface TaskActorResolver { resolveTrustedActor(): Promise<TaskActor> }

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
}
