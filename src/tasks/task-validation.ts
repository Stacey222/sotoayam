import { AppError } from "../errors.js";
import { parsePositiveId } from "../validation.js";
import {
  TASK_ACTIVITY_TYPES, TASK_EVIDENCE_TYPES, TASK_PRIORITIES, TASK_RELATIONSHIP_TYPES,
  TASK_STATUSES, TASK_VISIBILITIES, type AddTaskActivityInput, type CreateTaskInput,
  type EvidenceInput, type TaskFilters, type TaskPriority, type TaskRelationshipType,
  type TaskStatus, type TransitionTaskInput, type UpdateTaskInput,
} from "./types.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object");
  return value as Record<string, unknown>;
}
function unknownField(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new AppError(400, "VALIDATION_ERROR", `Field is not allowed: ${unknown}`);
}
function optionalId(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new AppError(400, "VALIDATION_ERROR", `${field} must be a positive integer or null`);
  return value;
}
function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  if (typeof value !== "string") throw new AppError(400, "VALIDATION_ERROR", `${field} must be a string or null`);
  return value;
}
function evidence(value: unknown): EvidenceInput | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  const body = object(value); unknownField(body, ["type", "reference"]);
  if (typeof body.type !== "string" || body.type === "NONE" || !TASK_EVIDENCE_TYPES.includes(body.type as never)) throw new AppError(400, "VALIDATION_ERROR", "Invalid evidence type");
  if (typeof body.reference !== "string") throw new AppError(400, "VALIDATION_ERROR", "Evidence reference must be a string");
  return { type: body.type as EvidenceInput["type"], reference: body.reference };
}

export function parseCreateTask(bodyValue: unknown): CreateTaskInput {
  const body = object(bodyValue); unknownField(body, ["title", "description", "priority", "deadline", "assigned_to", "owner_division_id"]);
  if (typeof body.title !== "string") throw new AppError(400, "VALIDATION_ERROR", "Task title is required");
  if (body.priority !== undefined && (typeof body.priority !== "string" || !TASK_PRIORITIES.includes(body.priority as never))) throw new AppError(400, "VALIDATION_ERROR", "Invalid task priority");
  return { title: body.title, description: optionalString(body.description, "description"), priority: body.priority as TaskPriority | undefined,
    deadline: optionalString(body.deadline, "deadline"), assignedToUserId: optionalId(body.assigned_to, "assigned_to"),
    ownerDivisionId: optionalId(body.owner_division_id, "owner_division_id") ?? undefined };
}

export function parseUpdateTask(bodyValue: unknown): UpdateTaskInput {
  const body = object(bodyValue); unknownField(body, ["title", "description", "priority", "deadline", "assigned_to"]);
  if (Object.keys(body).length === 0) throw new AppError(400, "VALIDATION_ERROR", "At least one task field is required");
  if (body.title !== undefined && typeof body.title !== "string") throw new AppError(400, "VALIDATION_ERROR", "Task title must be a string");
  if (body.priority !== undefined && (typeof body.priority !== "string" || !TASK_PRIORITIES.includes(body.priority as never))) throw new AppError(400, "VALIDATION_ERROR", "Invalid task priority");
  return { title: body.title as string | undefined, description: optionalString(body.description, "description"), priority: body.priority as TaskPriority | undefined,
    deadline: optionalString(body.deadline, "deadline"), assignedToUserId: optionalId(body.assigned_to, "assigned_to") };
}

export function parseTransition(bodyValue: unknown): TransitionTaskInput {
  const body = object(bodyValue); unknownField(body, ["status", "note", "evidence"]);
  if (typeof body.status !== "string" || !TASK_STATUSES.includes(body.status as never)) throw new AppError(400, "VALIDATION_ERROR", "Invalid task status");
  return { status: body.status as TaskStatus, note: optionalString(body.note, "note"), evidence: evidence(body.evidence) };
}

export function parseActivity(bodyValue: unknown): AddTaskActivityInput {
  const body = object(bodyValue); unknownField(body, ["activity_type", "note", "visibility", "evidence"]);
  if (typeof body.activity_type !== "string" || !TASK_ACTIVITY_TYPES.includes(body.activity_type as never)) throw new AppError(400, "VALIDATION_ERROR", "Invalid activity type");
  if (body.visibility !== undefined && (typeof body.visibility !== "string" || !TASK_VISIBILITIES.includes(body.visibility as never))) throw new AppError(400, "VALIDATION_ERROR", "Invalid activity visibility");
  return { activityType: body.activity_type as AddTaskActivityInput["activityType"], note: optionalString(body.note, "note"),
    visibility: body.visibility as AddTaskActivityInput["visibility"], evidence: evidence(body.evidence) };
}

export function parseRelationship(bodyValue: unknown): { targetId: number; type: TaskRelationshipType } {
  const body = object(bodyValue); unknownField(body, ["target_task_id", "relationship_type"]);
  const targetId = optionalId(body.target_task_id, "target_task_id");
  if (targetId === undefined || targetId === null) throw new AppError(400, "VALIDATION_ERROR", "target_task_id is required");
  if (typeof body.relationship_type !== "string" || !TASK_RELATIONSHIP_TYPES.includes(body.relationship_type as never)) throw new AppError(400, "VALIDATION_ERROR", "Invalid relationship type");
  return { targetId, type: body.relationship_type as TaskRelationshipType };
}

export function parseTaskFilters(value: unknown): TaskFilters {
  const query = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const filters: TaskFilters = {};
  if (query.status !== undefined) {
    if (typeof query.status !== "string" || !TASK_STATUSES.includes(query.status as never)) throw new AppError(400, "VALIDATION_ERROR", "Invalid status filter");
    filters.status = query.status as TaskStatus;
  }
  if (query.priority !== undefined) {
    if (typeof query.priority !== "string" || !TASK_PRIORITIES.includes(query.priority as never)) throw new AppError(400, "VALIDATION_ERROR", "Invalid priority filter");
    filters.priority = query.priority as TaskPriority;
  }
  if (query.assigned_to !== undefined) filters.assignedToUserId = parsePositiveId(String(query.assigned_to));
  if (query.owner_division !== undefined) filters.ownerDivisionId = parsePositiveId(String(query.owner_division));
  if (query.overdue !== undefined) {
    if (query.overdue !== "true" && query.overdue !== "false") throw new AppError(400, "VALIDATION_ERROR", "Invalid overdue filter");
    filters.overdue = query.overdue === "true";
  }
  return filters;
}
