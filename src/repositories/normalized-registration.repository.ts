import type { SupabaseClient } from "@supabase/supabase-js";
import type { TelegramRegistration, TelegramUser } from "../types/index.js";
import { governanceDatabaseError } from "./governance-database-error.js";
import type { TelegramRegistrationWriter } from "../services/telegram-registration.service.js";

export class SupabaseNormalizedRegistrationRepository implements TelegramRegistrationWriter {
  constructor(private readonly client: SupabaseClient) {}

  async upsertTelegramRegistration(registration: TelegramRegistration): Promise<TelegramUser> {
    const { data, error } = await this.client
      .rpc("register_telegram_identity", {
        p_telegram_chat_id: registration.telegram_chat_id,
        p_telegram_username: registration.telegram_username,
        p_telegram_first_name: registration.telegram_first_name,
      })
      .single();
    if (error) throw governanceDatabaseError("Unable to synchronize Telegram identity", error);
    return data as TelegramUser;
  }
}
