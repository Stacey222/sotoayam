import { hashPassword, validatePasswordPolicy } from "../auth/admin-password.js";
import {
  FirstAdminBootstrapError,
  type FirstAdminBootstrapRepository,
  type FirstAdminBootstrapStatus,
  type FirstOwnerProvisioningResult,
} from "../repositories/first-admin-bootstrap.repository.js";
import { normalizeFirstAdminIdentity } from "./first-admin-bootstrap.service.js";

export interface FirstOwnerBootstrapInput {
  displayName: string;
  email: string;
  password: string | Uint8Array;
  divisionCode: string;
  divisionName: string;
  businessTimeZone: string;
}

export interface CreatedFirstOwner extends FirstOwnerProvisioningResult {
  email: string;
  displayName: string;
  authority: "SYSTEM_ADMIN";
  role: "OWNER";
  passwordChangeRequired: false;
}

export class FirstOwnerBootstrapService {
  constructor(private readonly repository: FirstAdminBootstrapRepository,
    private readonly runtimeDefaults: { reminderSchedulerIntervalSeconds: number; criticalAlertPolicy: unknown }) {}

  getStatus(): Promise<FirstAdminBootstrapStatus> {
    return this.repository.getStatus();
  }

  async provision(input: FirstOwnerBootstrapInput): Promise<CreatedFirstOwner> {
    const identity = normalizeFirstAdminIdentity(input.displayName, input.email);
    const plaintext = typeof input.password === "string" ? input.password : Buffer.from(input.password).toString("utf8");
    try { validatePasswordPolicy(plaintext, identity); }
    catch { throw new FirstAdminBootstrapError("WEAK_PASSWORD", "Password does not meet the bootstrap password policy"); }
    if (!this.repository.provisionOwner) {
      throw new FirstAdminBootstrapError("INCOMPATIBLE_SCHEMA", "First-owner schema is unavailable; apply migrations first");
    }
    const passwordHash = await hashPassword(input.password);
    const result = await this.repository.provisionOwner({
      ...identity,
      passwordAlgorithm: "scrypt",
      passwordHash,
      divisionCode: input.divisionCode,
      divisionName: input.divisionName,
      businessTimeZone: input.businessTimeZone,
      reminderSchedulerIntervalSeconds: this.runtimeDefaults.reminderSchedulerIntervalSeconds,
      criticalAlertPolicy: this.runtimeDefaults.criticalAlertPolicy,
    });
    return { ...result, ...identity, authority: "SYSTEM_ADMIN", role: "OWNER", passwordChangeRequired: false };
  }
}
