import { hashPassword, validatePasswordPolicy } from "../auth/admin-password.js";
import {
  FirstAdminBootstrapError,
  type FirstAdminBootstrapRepository,
  type FirstAdminBootstrapResult,
  type FirstAdminBootstrapStatus,
  type FirstAdminSetupPreview,
  type SetupLineage,
} from "../repositories/first-admin-bootstrap.repository.js";

const EMAIL_PATTERN = /^[^@\s\p{Cc}]+@[^@.\s\p{Cc}]+(?:\.[^@.\s\p{Cc}]+)+$/u;

export interface FirstAdminInput {
  displayName: string;
  email: string;
  password: string | Uint8Array;
}

export interface CreatedFirstAdmin extends FirstAdminBootstrapResult {
  email: string;
  displayName: string;
  authority: "SYSTEM_ADMIN";
  division: string;
  role: "ADMIN";
}

export function normalizeFirstAdminIdentity(displayName: string, email: string): { displayName: string; email: string } {
  const normalizedName = displayName.trim();
  const normalizedEmail = email.trim().toLocaleLowerCase("en-US");
  if (!normalizedName || normalizedName.length > 120 || /[\p{Cc}]/u.test(normalizedName)) {
    throw new FirstAdminBootstrapError("INVALID_DISPLAY_NAME", "Display name must contain 1-120 characters and no control characters");
  }
  if (normalizedEmail.length > 254 || !EMAIL_PATTERN.test(normalizedEmail)) {
    throw new FirstAdminBootstrapError("INVALID_EMAIL", "Email address is invalid");
  }
  return { displayName: normalizedName, email: normalizedEmail };
}

export class FirstAdminBootstrapService {
  constructor(private readonly repository: FirstAdminBootstrapRepository) {}

  getStatus(): Promise<FirstAdminBootstrapStatus> {
    return this.repository.getStatus();
  }

  preview(lineage: SetupLineage): Promise<FirstAdminSetupPreview> {
    if (!this.repository.preview) throw new FirstAdminBootstrapError("INCOMPATIBLE_SCHEMA", "Installation preview is unavailable; apply migrations first");
    return this.repository.preview(lineage);
  }

  async resolveActiveDivision(code: string): Promise<{ code: string; name: string }> {
    if (!this.repository.resolveActiveDivision) {
      throw new FirstAdminBootstrapError("INCOMPATIBLE_SCHEMA", "Active division precheck is unavailable; apply migrations first");
    }
    const division = await this.repository.resolveActiveDivision(code);
    if (!division) throw new FirstAdminBootstrapError("TAXONOMY_UNAVAILABLE", "Selected active division is unavailable");
    return division;
  }

  async provision(input: FirstAdminInput & { lineage: SetupLineage; divisionCode: string; divisionName: string }): Promise<CreatedFirstAdmin> {
    const identity = normalizeFirstAdminIdentity(input.displayName, input.email);
    const plaintext = typeof input.password === "string" ? input.password : Buffer.from(input.password).toString("utf8");
    try { validatePasswordPolicy(plaintext, identity); }
    catch { throw new FirstAdminBootstrapError("WEAK_PASSWORD", "Password does not meet the bootstrap password policy"); }
    const passwordHash = await hashPassword(input.password);
    if (!this.repository.provision) throw new FirstAdminBootstrapError("INCOMPATIBLE_SCHEMA", "Installation provisioning is unavailable; apply migrations first");
    const result = await this.repository.provision({
      ...identity, passwordAlgorithm: "scrypt", passwordHash,
      lineage: input.lineage, divisionCode: input.divisionCode, divisionName: input.divisionName,
    });
    return { ...result, ...identity, authority: "SYSTEM_ADMIN", division: result.divisionCode, role: "ADMIN" };
  }

  async bootstrap(input: FirstAdminInput): Promise<CreatedFirstAdmin> {
    const identity = normalizeFirstAdminIdentity(input.displayName, input.email);
    const plaintext = typeof input.password === "string" ? input.password : Buffer.from(input.password).toString("utf8");
    try {
      validatePasswordPolicy(plaintext, identity);
    } catch {
      throw new FirstAdminBootstrapError("WEAK_PASSWORD", "Password does not meet the bootstrap password policy");
    }
    const passwordHash = await hashPassword(input.password);
    const result = await this.repository.bootstrap({
      ...identity,
      passwordAlgorithm: "scrypt",
      passwordHash,
    });
    return { ...result, ...identity, authority: "SYSTEM_ADMIN", division: "IT", role: "ADMIN" };
  }
}
