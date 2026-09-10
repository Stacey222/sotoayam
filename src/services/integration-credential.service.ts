import { AppError } from "../errors.js";
import { generateIntegrationCredential, integrationUnauthorized, parseIntegrationCredential,
  hashIntegrationSecret, type IntegrationCredentialAuthenticator, type IntegrationPrincipal } from "../auth/integration-credential.js";
import type { IntegrationCredentialMetadata, IntegrationCredentialRepository,
  IntegrationCredentialRevocationReason } from "../repositories/integration-credential.repository.js";
import type { IntegrationCapabilityCode } from "../repositories/task-ingestion.repository.js";

const REASONS = new Set<IntegrationCredentialRevocationReason>(["ROTATED", "COMPROMISED", "DECOMMISSIONED", "INTEGRATION_DISABLED"]);

export class IntegrationCredentialService implements IntegrationCredentialAuthenticator {
  constructor(private readonly repository: IntegrationCredentialRepository) {}

  async authenticate(rawCredential: unknown, requiredCapability: IntegrationCapabilityCode | null): Promise<IntegrationPrincipal> {
    const parsed = parseIntegrationCredential(rawCredential);
    if (!parsed) throw integrationUnauthorized();
    const result = await this.repository.authenticate(parsed.selector, hashIntegrationSecret(parsed.secret), requiredCapability);
    if (result.status === "CAPABILITY_MISSING") {
      throw new AppError(403, "INTEGRATION_CAPABILITY_REQUIRED", "Integration does not have the required capability");
    }
    if (result.status !== "OK" || !result.principal) throw integrationUnauthorized();
    return result.principal;
  }

  async create(input: { integrationId: number; label: unknown; expiresAt?: unknown;
    rotationOfCredentialId?: unknown; actorUserId: number }): Promise<IntegrationCredentialMetadata & { credential: string }> {
    if (typeof input.label !== "string" || input.label.trim().length < 1 || input.label.trim().length > 100) {
      throw new AppError(400, "INTEGRATION_CREDENTIAL_INVALID", "Credential label must contain 1 to 100 characters");
    }
    let expiresAt: string | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      if (typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) {
        throw new AppError(400, "INTEGRATION_CREDENTIAL_INVALID", "Credential expiry must be a future timestamp");
      }
      expiresAt = new Date(input.expiresAt).toISOString();
    }
    const rotationOfCredentialId = input.rotationOfCredentialId === undefined || input.rotationOfCredentialId === null
      ? null : positiveId(input.rotationOfCredentialId, "rotation_of_credential_id");
    const generated = generateIntegrationCredential();
    const created = await this.repository.create({ integrationId: input.integrationId, selector: generated.selector,
      secretHash: generated.secretHash, label: input.label.trim(), expiresAt, rotationOfCredentialId,
      actorUserId: input.actorUserId });
    return { ...created, credential: generated.credential };
  }

  list(integrationId: number, actorUserId: number): Promise<IntegrationCredentialMetadata[]> {
    return this.repository.list(integrationId, actorUserId);
  }

  revoke(input: { credentialId: number; reason?: unknown; graceSeconds?: unknown; actorUserId: number }): Promise<IntegrationCredentialMetadata> {
    const reason = input.reason === undefined ? "ROTATED" : String(input.reason).trim().toUpperCase();
    if (!REASONS.has(reason as IntegrationCredentialRevocationReason)) {
      throw new AppError(400, "INTEGRATION_CREDENTIAL_INVALID", "Credential revocation reason is invalid");
    }
    let graceSeconds: number | null = null;
    if (input.graceSeconds !== undefined && input.graceSeconds !== null) {
      if (typeof input.graceSeconds !== "number" || !Number.isSafeInteger(input.graceSeconds)
        || input.graceSeconds < 1 || input.graceSeconds > 604_800) {
        throw new AppError(400, "INTEGRATION_CREDENTIAL_INVALID", "grace_seconds must be between 1 and 604800");
      }
      graceSeconds = input.graceSeconds;
    }
    return this.repository.revoke({ credentialId: input.credentialId,
      reason: reason as IntegrationCredentialRevocationReason, graceSeconds, actorUserId: input.actorUserId });
  }
}

function positiveId(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AppError(400, "INTEGRATION_CREDENTIAL_INVALID", `${field} must be a positive integer`);
  }
  return value;
}
