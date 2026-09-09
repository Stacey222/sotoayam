import { AppError } from "../errors.js";
import type { DivisionsRepository } from "../repositories/divisions.repository.js";
import type { IntegrationAdministrationRepository } from "../repositories/integration-administration.repository.js";
import { INTEGRATION_CAPABILITIES, type IntegrationCapabilityCode } from "../repositories/task-ingestion.repository.js";
import type { SystemAuthorityRepository } from "../repositories/system-authority.repository.js";
import type { TaskUsersRepository } from "../repositories/task-users.repository.js";
import type { UserManagementService } from "./user-management.service.js";
import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";

export class IntegrationAdministrationService {
  constructor(
    private readonly integrations: IntegrationAdministrationRepository,
    private readonly divisions: DivisionsRepository,
    private readonly taskUsers: TaskUsersRepository,
    private readonly users: UserManagementService,
    private readonly authorities: SystemAuthorityRepository,
  ) {}

  async list(actorUserId?: number) { await this.authorizedActor(actorUserId); return this.integrations.list(); }
  async listCapabilities(id: number, actorUserId?: number) { await this.authorizedActor(actorUserId); await this.required(id); return this.integrations.listCapabilities(id); }

  async create(input: { code: string; name: string; source: "AUTOMATION" | "ERP"; requestingDivisionId: number }, actorUserId?: number) {
    const actorId = await this.authorizedActor(actorUserId);
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(code)) throw new AppError(400, "INTEGRATION_INVALID", "Integration code is invalid");
    if (!name || name.length > 200) throw new AppError(400, "INTEGRATION_INVALID", "Integration name is invalid");
    const division = (await this.divisions.findAll({ activeOnly: true })).find((item) => item.id === input.requestingDivisionId);
    if (!division?.active) throw new AppError(400, "INTEGRATION_INVALID", "Requesting Divisi is unknown or inactive");
    return this.integrations.create({ ...input, code, name, actorUserId: actorId });
  }

  async setActive(id: number, active: boolean, actorUserId?: number) {
    const actorId = await this.authorizedActor(actorUserId); await this.required(id);
    return this.integrations.setActive(id, active, actorId);
  }

  async grantCapability(id: number, capability: string, actorUserId?: number) {
    const actorId = await this.authorizedActor(actorUserId); await this.required(id);
    return this.integrations.grantCapability(id, this.capability(capability), actorId);
  }

  async revokeCapability(id: number, capability: string, actorUserId?: number) {
    const actorId = await this.authorizedActor(actorUserId); await this.required(id);
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

  private async authorizedActor(actorUserId?: number): Promise<number> {
    const id = actorUserId ?? (await this.taskUsers.findTrustedAdminActorUser()).id;
    const user = await this.users.get(id);
    if (!hasSystemAdminCapability({
      active: user.active,
      divisionId: user.division?.id ?? null,
      roleId: user.role?.id ?? null,
      divisionGrantsSystemAuthority: user.division?.grants_system_authority,
    }) || !await this.authorities.findActiveForUser(user.id)) {
      throw new AppError(403, "INTEGRATION_ADMIN_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
    }
    return user.id;
  }
}
