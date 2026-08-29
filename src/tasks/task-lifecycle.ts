import { AppError } from "../errors.js";
import type { Task, TaskStatus } from "./types.js";

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  DRAFT: ["OPEN", "CANCELLED"],
  OPEN: ["IN_PROGRESS", "BLOCKED", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "COMPLETED", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new AppError(409, "TASK_INVALID_STATUS_TRANSITION", `Task cannot transition from ${from} to ${to}`);
  }
}

export function lifecycleTimestamps(task: Task, status: TaskStatus, now: Date): Pick<Task, "started_at" | "completed_at" | "cancelled_at"> {
  assertTaskTransition(task.status, status);
  return {
    started_at: status === "IN_PROGRESS" ? task.started_at ?? now.toISOString() : task.started_at,
    completed_at: status === "COMPLETED" ? now.toISOString() : null,
    cancelled_at: status === "CANCELLED" ? now.toISOString() : null,
  };
}

export function isTaskOverdue(task: Pick<Task, "deadline" | "status">, now = new Date()): boolean {
  return Boolean(task.deadline && new Date(task.deadline).getTime() < now.getTime()
    && task.status !== "COMPLETED" && task.status !== "CANCELLED");
}
