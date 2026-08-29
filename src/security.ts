import { createHash, timingSafeEqual } from "node:crypto";

export function secureEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
