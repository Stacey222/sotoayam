import type { TelegramUsersRepository } from "../repositories/telegram-users.repository.js";
import type { NotificationPreferenceShadowRepository } from "../repositories/notification-preferences.repository.js";
import {
  NOTIFICATION_PREFERENCE_BY_TYPE,
  type NotificationType,
  type TelegramUser,
} from "../types/index.js";

export class RecipientResolverService {
  constructor(private readonly usersRepository: TelegramUsersRepository,
    private readonly shadow?: NotificationPreferenceShadowRepository,
    private readonly parityLogger?: { info(fields: Record<string, unknown>, message: string): void;
      warn(fields: Record<string, unknown>, message: string): void },
    private readonly mode: "LEGACY" | "COMPARE" | "NORMALIZED" = "LEGACY") {}

  async resolve(type: NotificationType): Promise<TelegramUser[]> {
    if (this.mode === "NORMALIZED" && this.shadow) {
      return this.shadow.findNormalizedRecipients(type);
    }
    const legacy = await this.usersRepository.findRecipientsForNotification(NOTIFICATION_PREFERENCE_BY_TYPE[type]);
    if (this.mode === "COMPARE" && this.shadow) {
      try {
        const normalized = await this.shadow.findNormalizedRecipients(type);
        const legacyIds = new Set(legacy.map((user) => user.id));
        const normalizedIds = new Set(normalized.map((user) => user.id));
        const mismatchCount = [...legacyIds].filter((id) => !normalizedIds.has(id)).length
          + [...normalizedIds].filter((id) => !legacyIds.has(id)).length;
        const fields = { notification_type: type, legacy_recipient_count: legacyIds.size,
          normalized_recipient_count: normalizedIds.size, mismatch_count: mismatchCount, parity: mismatchCount === 0 };
        if (mismatchCount === 0) this.parityLogger?.info(fields, "Notification preference recipient parity");
        else this.parityLogger?.warn(fields, "Notification preference recipient mismatch");
      } catch {
        this.parityLogger?.warn({ notification_type: type, parity: false }, "Notification preference comparison unavailable");
      }
    }
    return legacy;
  }
}
