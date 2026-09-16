import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseError } from "../errors.js";
import type { NotificationType, TelegramUser } from "../types/index.js";

export interface NotificationPreferenceShadowRepository {
  findNormalizedRecipients(type: NotificationType): Promise<TelegramUser[]>;
}

export class SupabaseNotificationPreferenceShadowRepository implements NotificationPreferenceShadowRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findNormalizedRecipients(type: NotificationType): Promise<TelegramUser[]> {
    const { data, error } = await this.client.rpc("find_shadow_notification_recipients", { p_notification_type: type });
    if (error) throw new DatabaseError("Unable to compare notification recipients", {
      code: error.code, message: error.message, details: error.details, hint: error.hint,
    });
    return (data ?? []) as TelegramUser[];
  }
}
