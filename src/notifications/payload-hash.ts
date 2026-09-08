import { createHash } from "node:crypto";
import type { NotificationEvent } from "../types/index.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function notificationPayloadHash(event: NotificationEvent): string {
  const canonicalPayload = {
    type: event.type,
    message: event.message,
    metadata: canonicalize(event.metadata ?? null),
  };
  return createHash("sha256").update(JSON.stringify(canonicalPayload), "utf8").digest("hex");
}

export function notificationRecipientDedupeKey(source: string, externalEventId: string, legacyId: number): string {
  return createHash("sha256")
    .update(["NOTIFICATION_EVENT", source, externalEventId, String(legacyId)].join(":"), "utf8")
    .digest("hex");
}
