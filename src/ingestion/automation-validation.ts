import { AppError } from "../errors.js";
import type { TaskIntakeRequest } from "./types.js";
import { TASK_PRIORITIES } from "../tasks/types.js";

export function parseAutomationIntake(value: unknown): TaskIntakeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  const body = value as Record<string, unknown>;
  const allowed = ["external_reference", "title", "description", "priority", "owner_division", "assignee", "deadline"];
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new AppError(400, "VALIDATION_ERROR", `Field is not allowed: ${unknown}`);
  if (typeof body.title !== "string" || typeof body.owner_division !== "string") throw new AppError(400, "VALIDATION_ERROR", "title and owner_division are required");
  const optional = (key: string): string | null | undefined => {
    const item = body[key];
    if (item === undefined || item === null) return item as null | undefined;
    if (typeof item !== "string") throw new AppError(400, "VALIDATION_ERROR", `${key} must be a string or null`);
    return item;
  };
  const priority = optional("priority")?.toUpperCase();
  if (priority && !TASK_PRIORITIES.includes(priority as never)) throw new AppError(400, "INVALID_PRIORITY", "Task priority is invalid");
  const deadline = optional("deadline");
  if (deadline && (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || new Date(`${deadline}T00:00:00.000Z`).toISOString().slice(0, 10) !== deadline)) {
    throw new AppError(400, "INVALID_DEADLINE", "Deadline must use YYYY-MM-DD");
  }
  return { source: "AUTOMATION", title: body.title, ownerDivision: body.owner_division,
    description: optional("description"), priority: priority as TaskIntakeRequest["priority"],
    assignee: optional("assignee"), deadline, externalReference: optional("external_reference") };
}
