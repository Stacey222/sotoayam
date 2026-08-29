import { AppError } from "./errors.js";
import {
  DIVISIONS,
  NOTIFICATION_PREFERENCE_BY_TYPE,
  NOTIFICATION_PREFERENCES,
  ROLES,
  type NotificationEvent,
  type UserFilters,
  type UserUpdate,
} from "./types/index.js";

function validationError(message: string): never {
  throw new AppError(400, "VALIDATION_ERROR", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePositiveId(value: string): number {
  if (!/^\d+$/.test(value)) validationError("Invalid user id");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) validationError("Invalid user id");
  return id;
}

export function parseUserFilters(query: unknown): UserFilters {
  if (!isRecord(query)) return {};
  const filters: UserFilters = {};
  if (query.status !== undefined) {
    if (!(["pending", "active", "inactive"] as unknown[]).includes(query.status)) {
      validationError("Invalid status filter");
    }
    filters.status = query.status as UserFilters["status"];
  }
  if (query.division !== undefined) {
    if (typeof query.division !== "string" || !DIVISIONS.includes(query.division as never)) {
      validationError("Invalid division filter");
    }
    filters.division = query.division;
  }
  if (query.active !== undefined) {
    if (query.active !== "true" && query.active !== "false") validationError("Invalid active filter");
    filters.active = query.active === "true";
  }
  return filters;
}

export function parseUserUpdate(body: unknown): UserUpdate {
  if (!isRecord(body)) validationError("Request body must be an object");
  const allowed = new Set(["name", "division", "role", "active", ...NOTIFICATION_PREFERENCES]);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) validationError(`Field is not allowed: ${unknown}`);
  if (Object.keys(body).length === 0) validationError("At least one field is required");

  const update: UserUpdate = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.trim().length > 100) {
      validationError("Name must contain 1-100 characters");
    }
    update.name = body.name.trim();
  }
  if (body.division !== undefined) {
    if (typeof body.division !== "string" || !DIVISIONS.includes(body.division as never)) {
      validationError("Invalid division");
    }
    update.division = body.division;
  }
  if (body.role !== undefined) {
    if (typeof body.role !== "string" || !ROLES.includes(body.role as never)) validationError("Invalid role");
    update.role = body.role;
  }
  for (const field of ["active", ...NOTIFICATION_PREFERENCES] as const) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "boolean") validationError(`${field} must be a boolean`);
      update[field] = body[field];
    }
  }
  return update;
}

export function parseNotificationEvent(body: unknown): NotificationEvent {
  if (!isRecord(body)) validationError("Request body must be an object");
  if (typeof body.type !== "string" || !(body.type in NOTIFICATION_PREFERENCE_BY_TYPE)) {
    validationError("Invalid notification type");
  }
  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    validationError("Message must not be empty");
  }
  if (body.message.length > 4096) validationError("Message must not exceed 4096 characters");
  if (body.event_id !== undefined && (typeof body.event_id !== "string" || body.event_id.length > 200)) {
    validationError("Invalid event_id");
  }
  if (body.metadata !== undefined && !isRecord(body.metadata)) validationError("Metadata must be an object");

  return {
    type: body.type as NotificationEvent["type"],
    message: body.message.trim(),
    ...(body.event_id ? { event_id: body.event_id as string } : {}),
    ...(body.metadata ? { metadata: body.metadata } : {}),
  };
}
