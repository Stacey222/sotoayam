import { AppError } from "../errors.js";
import { resolveUserAccessState, type UserAccessState } from "../identity/user-access-state.js";
import type { UserAccessStateRepository } from "../repositories/user-access-state.repository.js";

export interface UserAccessStateResolver {
  resolveByLegacyTelegramUserId(legacyUserId: number): Promise<UserAccessState>;
}

export class UserAccessStateService implements UserAccessStateResolver {
  constructor(private readonly repository: UserAccessStateRepository) {}

  async resolveByLegacyTelegramUserId(legacyUserId: number): Promise<UserAccessState> {
    const snapshot = await this.repository.findByLegacyTelegramUserId(legacyUserId);
    if (!snapshot) throw new AppError(404, "NORMALIZED_USER_NOT_FOUND", "Normalized user access state not found");
    return resolveUserAccessState(snapshot);
  }
}
