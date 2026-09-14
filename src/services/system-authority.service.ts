import { AppError, DatabaseError } from "../errors.js";
import type { SystemAuthorityRepository } from "../repositories/system-authority.repository.js";
import type { UsersRepository } from "../repositories/users.repository.js";

export class SystemAuthorityService {
  constructor(
    private readonly users: UsersRepository,
    private readonly authorities: SystemAuthorityRepository,
  ) {}

  async status(): Promise<{ bootstrap: "READY" | "WAITING_FOR_AUTHORITY_CAPABLE_USER"; candidate_count: number; active_count: number }> {
    const [candidateCount, activeCount] = await Promise.all([
      this.users.countSystemAdminCandidates(), this.authorities.countActive(),
    ]);
    return {
      bootstrap: candidateCount === 0 && activeCount === 0 ? "WAITING_FOR_AUTHORITY_CAPABLE_USER" : "READY",
      candidate_count: candidateCount,
      active_count: activeCount,
    };
  }

  async assign(userId: number, reason: string, actorUserId: number) {
    try {
      return await this.authorities.assign(userId, reason, actorUserId);
    } catch (error) {
      if (error instanceof DatabaseError && error.diagnostic.code === "42501") {
        throw new AppError(403, "SYSTEM_AUTHORITY_FORBIDDEN", "Active SYSTEM_ADMIN authority is required");
      }
      if (error instanceof DatabaseError && error.diagnostic.code === "P0001") {
        const last = error.diagnostic.message?.includes("LAST_SYSTEM_ADMIN") === true;
        throw new AppError(
          409,
          last ? "LAST_SYSTEM_ADMIN" : "GOVERNANCE_INVARIANT",
          error.diagnostic.message ?? "SYSTEM_ADMIN assignment rejected",
        );
      }
      throw error;
    }
  }

  async revoke(userId: number, reason: string, actorUserId: number) {
    try {
      return await this.authorities.revoke(userId, reason, actorUserId);
    } catch (error) {
      if (error instanceof DatabaseError && error.diagnostic.code === "42501") {
        throw new AppError(403, "SYSTEM_AUTHORITY_FORBIDDEN", "Active SYSTEM_ADMIN authority is required");
      }
      if (error instanceof DatabaseError && (error.diagnostic.code === "P0001" || error.diagnostic.code === "P0002")) {
        const missing = error.diagnostic.code === "P0002";
        const last = error.diagnostic.message?.includes("LAST_SYSTEM_ADMIN") === true;
        throw new AppError(
          missing ? 404 : 409,
          missing ? "GOVERNANCE_INVARIANT" : last ? "LAST_SYSTEM_ADMIN" : "GOVERNANCE_INVARIANT",
          error.diagnostic.message ?? "SYSTEM_ADMIN revocation rejected",
        );
      }
      throw error;
    }
  }

  async setDivisionCapability(divisionId: number, enabled: boolean, actorUserId: number) {
    if (!this.authorities.setDivisionCapability) throw new AppError(503, "SYSTEM_AUTHORITY_UNAVAILABLE", "Division authority capability management is unavailable");
    try { return await this.authorities.setDivisionCapability(divisionId, enabled, actorUserId); }
    catch (error) {
      if (error instanceof DatabaseError && ["P0001", "P0002", "42501"].includes(error.diagnostic.code ?? "")) {
        const missing = error.diagnostic.code === "P0002";
        const forbidden = error.diagnostic.code === "42501";
        const last = error.diagnostic.message?.includes("LAST_SYSTEM_ADMIN") === true;
        throw new AppError(
          missing ? 404 : forbidden ? 403 : 409,
          missing ? "DIVISION_NOT_FOUND" : forbidden ? "SYSTEM_AUTHORITY_FORBIDDEN" : last ? "LAST_SYSTEM_ADMIN" : "DIVISION_AUTHORITY_REQUIRED",
          error.diagnostic.message ?? "Division authority capability change rejected",
        );
      }
      throw error;
    }
  }
}
