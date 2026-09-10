import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import type { IntegrationCapabilityCode } from "../repositories/task-ingestion.repository.js";

const SELECTOR_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const CREDENTIAL_PATTERN = /^soto_ik_([0-9abcdefghjkmnpqrstvwxyz]{16})_([A-Za-z0-9_-]{43})$/;

export interface IntegrationPrincipal {
  integrationId: number;
  credentialId: number;
  code: string;
  source: "AUTOMATION" | "ERP";
  requestingDivisionId: number;
}

export type IntegrationAuthenticationStatus = "OK" | "UNKNOWN" | "BAD_SECRET" | "REVOKED"
  | "EXPIRED" | "INTEGRATION_INACTIVE" | "CAPABILITY_MISSING";

export interface IntegrationCredentialAuthenticator {
  authenticate(rawCredential: unknown, requiredCapability: IntegrationCapabilityCode | null): Promise<IntegrationPrincipal>;
}

export const INTEGRATION_UNAUTHORIZED_MESSAGE = "Invalid or missing integration credential";

export function parseIntegrationCredential(value: unknown): { selector: string; secret: string } | null {
  if (typeof value !== "string") return null;
  const match = CREDENTIAL_PATTERN.exec(value);
  return match ? { selector: match[1]!, secret: match[2]! } : null;
}

export function hashIntegrationSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateIntegrationCredential(random: (size: number) => Buffer = randomBytes): {
  selector: string; secret: string; credential: string; secretHash: string;
} {
  const selectorBytes = random(10);
  const secretBytes = random(32);
  try {
    let bits = 0n;
    for (const byte of selectorBytes) bits = (bits << 8n) | BigInt(byte);
    let selector = "";
    for (let index = 0; index < 16; index += 1) {
      selector = SELECTOR_ALPHABET[Number(bits & 31n)]! + selector;
      bits >>= 5n;
    }
    const secret = secretBytes.toString("base64url");
    return { selector, secret, credential: `soto_ik_${selector}_${secret}`,
      secretHash: hashIntegrationSecret(secret) };
  } finally {
    selectorBytes.fill(0);
    secretBytes.fill(0);
  }
}

export function integrationUnauthorized(): AppError {
  return new AppError(401, "INTEGRATION_UNAUTHORIZED", INTEGRATION_UNAUTHORIZED_MESSAGE);
}
