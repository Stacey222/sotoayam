import { hasSystemAdminCapability } from "../auth/system-admin-capability.js";
import { AppError, DatabaseError } from "../errors.js";
import type { DivisionsRepository } from "../repositories/divisions.repository.js";
import type { RolesRepository } from "../repositories/roles.repository.js";
import type { TaskActor } from "../tasks/types.js";

export class TaxonomyManagementService {
  constructor(private readonly divisions: DivisionsRepository, private readonly roles: RolesRepository) {}

  async listDivisions(activeOnly = false) {
    if (!this.divisions.findAdminCatalog) throw this.unavailable();
    return this.divisions.findAdminCatalog({ activeOnly });
  }

  async createDivision(input: { code: string; name: string }, actor: TaskActor) {
    this.actor(actor);
    if (!this.divisions.createManaged) throw this.unavailable();
    const code = input.code.trim().toUpperCase();
    const name = this.name(input.name, "Division");
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(code)) throw new AppError(400, "VALIDATION_ERROR", "Division code is invalid");
    try { return await this.divisions.createManaged({ code, name, actorUserId: actor.id }); }
    catch (error) { throw this.map(error); }
  }

  async updateDivision(id: number, input: { name?: string; active?: boolean }, actor: TaskActor) {
    this.actor(actor);
    if (!this.divisions.updateManaged) throw this.unavailable();
    try { return await this.divisions.updateManaged(id, {
      ...(input.name === undefined ? {} : { name: this.name(input.name, "Division") }),
      ...(input.active === undefined ? {} : { active: input.active }), actorUserId: actor.id,
    }); } catch (error) { throw this.map(error); }
  }

  async deleteDivision(id: number, actor: TaskActor) {
    this.actor(actor);
    if (!this.divisions.deleteManaged) throw this.unavailable();
    try { return await this.divisions.deleteManaged(id, actor.id); }
    catch (error) { throw this.map(error); }
  }

  async listRoles() {
    if (!this.roles.findManaged) throw this.unavailable();
    return this.roles.findManaged();
  }

  async renameRole(id: number, name: string, actor: TaskActor) {
    this.actor(actor);
    if (!this.roles.rename) throw this.unavailable();
    try { return await this.roles.rename(id, this.name(name, "Role"), actor.id); }
    catch (error) { throw this.map(error); }
  }

  private actor(actor: TaskActor): void {
    if (!hasSystemAdminCapability(actor)) {
      throw new AppError(403, "TAXONOMY_FORBIDDEN", "Active SYSTEM_ADMIN authority in an authority-capable division is required");
    }
  }

  private name(value: string, label: string): string {
    const name = value.trim();
    if (!name || name.length > 120) throw new AppError(400, "VALIDATION_ERROR", `${label} name must contain 1-120 characters`);
    return name;
  }

  private unavailable(): AppError { return new AppError(503, "TAXONOMY_UNAVAILABLE", "Taxonomy management is unavailable"); }
  private map(error: unknown): Error {
    if (!(error instanceof DatabaseError)) return error instanceof Error ? error : this.unavailable();
    const message = error.diagnostic.message ?? "Taxonomy mutation failed";
    if (message.includes("DIVISION_DUPLICATE_CODE")) return new AppError(409, "DIVISION_DUPLICATE_CODE", "Division code already exists");
    if (message.includes("DIVISION_IN_USE")) return new AppError(409, "DIVISION_IN_USE", "Division is still referenced");
    if (message.includes("DIVISION_AUTHORITY_REQUIRED")) return new AppError(409, "DIVISION_AUTHORITY_REQUIRED", "At least one active authority-capable division is required");
    if (message.includes("DIVISION_NOT_FOUND")) return new AppError(404, "DIVISION_NOT_FOUND", "Division not found");
    if (message.includes("ROLE_NOT_FOUND")) return new AppError(404, "ROLE_NOT_FOUND", "Reserved role not found");
    return error;
  }
}

