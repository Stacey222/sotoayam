import { AppError } from "../errors.js";
import type { Task, TaskActor } from "../tasks/types.js";

export class TaskAuthorizationService {
  assertCanCreate(actor: TaskActor): void {
    this.assertActive(actor);
    this.require(actor, "task.create");
  }

  canView(actor: TaskActor, task: Task): boolean {
    if (!actor.active) return false;
    if (task.assigned_to_user_id === actor.id && actor.permissions.has("task.view_assigned")) return true;
    return actor.divisionId === task.owner_division_id && actor.permissions.has("task.view_division");
  }

  assertCanView(actor: TaskActor, task: Task): void {
    if (!this.canView(actor, task)) throw new AppError(403, "TASK_FORBIDDEN", "Task is outside the actor's visibility");
  }

  assertCanUpdate(actor: TaskActor, task: Task): void {
    this.assertActive(actor);
    if (task.assigned_to_user_id !== actor.id || !actor.permissions.has("task.update_assigned")) {
      throw new AppError(403, "TASK_FORBIDDEN", "Actor cannot update this task");
    }
  }

  assertCanComplete(actor: TaskActor, task: Task): void {
    this.assertActive(actor);
    if (task.assigned_to_user_id !== actor.id || !actor.permissions.has("task.complete_assigned")) {
      throw new AppError(403, "TASK_FORBIDDEN", "Actor cannot complete this task");
    }
  }

  assertCanAddActivity(actor: TaskActor, task: Task): void {
    this.assertActive(actor);
    if (task.assigned_to_user_id !== actor.id || !actor.permissions.has("task.add_activity")) {
      throw new AppError(403, "TASK_FORBIDDEN", "Actor cannot add activity to this task");
    }
  }

  private assertActive(actor: TaskActor): void {
    if (!actor.active || actor.divisionId === null || actor.roleId === null) {
      throw new AppError(403, "TASK_FORBIDDEN", "Active normalized business identity is required");
    }
  }

  private require(actor: TaskActor, permission: string): void {
    if (!actor.permissions.has(permission)) throw new AppError(403, "TASK_FORBIDDEN", "Required task permission is missing");
  }
}
