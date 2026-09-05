import { AppError } from "../errors.js";
import type { DivisionsRepository } from "../repositories/divisions.repository.js";
import type { IntegrationAdministrationRepository } from "../repositories/integration-administration.repository.js";
import { INTEGRATION_CAPABILITIES, type IntegrationCapabilityCode } from "../repositories/task-ingestion.repository.js";
import type { SystemAuthorityRepository } from "../repositories/system-authority.repository.js";
import type { TaskActor } from "../tasks/types.js";

export class IntegrationAdministrationService {
  constructor(
    private readonly integrations: IntegrationAdministrationRepository,
    private readonly divisions: DivisionsRepository,
    private readonly authorities: SystemAuthorityRepository,
  ) {}

  async list(actor: TaskActor) { await this.authorizedActor(actor); return this.integrations.list(); }
  async listCapabilities(actor: TaskActor, id: number) { await this.authorizedActor(actor); await this.required(id); return this.integrations.listCapabilities(id); }

  async create(actor: TaskActor, input: { code: string; name: string; source: "AUTOMATION" | "ERP"; requestingDivisionId: number }) {
    const actorId = await this.authorizedActor(actor);
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(code)) throw new AppError(400, "INTEGRATION_INVALID", "Integration code is invalid");
    if (!name || name.length > 200) throw new AppError(400, "INTEGRATION_INVALID", "Integration name is invalid");
    const division = (await this.divisions.findAll({ activeOnly: true })).find((item) => item.id === input.requestingDivisionId);
    if (!division?.active) throw new AppError(400, "INTEGRATION_INVALID", "Requesting Divisi is unknown or inactive");
    return this.integrations.create({ ...input, code, name, actorUserId: actorId });
  }

  async setActive(actor: TaskActor, id: number, active: boolean) {
    const actorId = await this.authorizedActor(actor); await this.required(id);
    return this.integrations.setActive(id, active, actorId);
  }

  async grantCapability(actor: TaskActor, id: number, capability: string) {
    const actorId = await this.authorizedActor(actor); await this.required(id);
    return this.integrations.grantCapability(id, this.capability(capability), actorId);
  }

  async revokeCapability(actor: TaskActor, id: number, capability: string) {
    const actorId = await this.authorizedActor(actor); await this.required(id);
    return this.integrations.revokeCapability(id, this.capability(capability), actorId);
  }

  private capability(value: string): IntegrationCapabilityCode {
    const normalized = value.trim().toUpperCase();
    if (!INTEGRATION_CAPABILITIES.includes(normalized as IntegrationCapabilityCode)) {
      throw new AppError(400, "INTEGRATION_CAPABILITY_UNSUPPORTED", "Integration capability is not supported");
    }
    return normalized as IntegrationCapabilityCode;
  }

  private async required(id: number) {
    const integration = await this.integrations.findById(id);
    if (!integration) throw new AppError(404, "INTEGRATION_NOT_FOUND", "Integration identity not found");
    return integration;
  }

  private async authorizedActor(actor: TaskActor): Promise<number> {
    if (!actor.active || actor.divisionCode !== "IT" || !await this.authorities.findActiveForUser(actor.id)) {
      throw new AppError(403, "INTEGRATION_ADMIN_FORBIDDEN", "Active IT SYSTEM_ADMIN authority is required");
    }
    return actor.id;
  }
}
