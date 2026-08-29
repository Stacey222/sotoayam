import type { AuditState, JsonValue } from "./types.js";

const MAX_DEPTH = 6;
const MAX_SERIALIZED_BYTES = 32_768;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|token|api[_-]?key|service[_-]?(?:role|key)|credential)/i;
const SENSITIVE_VALUE = /(?:bearer\s+\S+|sb_(?:secret|publishable)_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b\d{6,}:[A-Za-z0-9_-]{20,}\b)/i;

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  if (depth > MAX_DEPTH) throw new Error("Audit state exceeds the allowed nesting depth");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Audit state contains a non-finite number");
    return value;
  }
  if (typeof value === "string") return SENSITIVE_VALUE.test(value) ? REDACTED : value;
  if (typeof value !== "object") throw new Error("Audit state contains an unsupported value");
  if (seen.has(value)) throw new Error("Audit state contains a circular reference");
  seen.add(value);

  const sanitized: JsonValue = Array.isArray(value)
    ? value.map((item) => sanitizeValue(item, depth + 1, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(item, depth + 1, seen),
        ]),
      );

  seen.delete(value);
  return sanitized;
}

export function sanitizeAuditState(value: unknown): AuditState | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Audit state must be an object");
  }
  const sanitized = sanitizeValue(value, 0, new WeakSet()) as AuditState;
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > MAX_SERIALIZED_BYTES) {
    throw new Error("Audit state exceeds the allowed serialized size");
  }
  return sanitized;
}
