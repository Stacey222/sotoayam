import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseError, type DatabaseDiagnostic } from "../errors.js";
import type {
  NotificationPreference,
  TelegramRegistration,
  TelegramUser,
  UserFilters,
  UserUpdate,
} from "../types/index.js";

export interface TelegramUsersRepository {
  findAll(filters?: UserFilters): Promise<TelegramUser[]>;
  findById(id: number): Promise<TelegramUser | null>;
  findByTelegramChatId(chatId: number): Promise<TelegramUser | null>;
  upsertTelegramRegistration(registration: TelegramRegistration): Promise<TelegramUser>;
  updateUser(id: number, update: UserUpdate): Promise<TelegramUser | null>;
  findRecipientsForNotification(preference: NotificationPreference): Promise<TelegramUser[]>;
}

function databaseError(message: string, error: DatabaseDiagnostic): DatabaseError {
  return new DatabaseError(message, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}

export class SupabaseTelegramUsersRepository implements TelegramUsersRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findAll(filters: UserFilters = {}): Promise<TelegramUser[]> {
    let query = this.client.from("telegram_users").select("*").order("created_at", { ascending: false });
    if (filters.status === "pending") query = query.eq("division", "UNASSIGNED").eq("active", false);
    if (filters.status === "active") query = query.eq("active", true);
    if (filters.status === "inactive") query = query.eq("active", false).neq("division", "UNASSIGNED");
    if (filters.division) query = query.eq("division", filters.division);
    if (filters.active !== undefined) query = query.eq("active", filters.active);

    const { data, error } = await query;
    if (error) throw databaseError("Unable to load Telegram users", error);
    return (data ?? []) as TelegramUser[];
  }

  async findById(id: number): Promise<TelegramUser | null> {
    const { data, error } = await this.client
      .from("telegram_users")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw databaseError("Unable to load Telegram user", error);
    return data as TelegramUser | null;
  }

  async findByTelegramChatId(chatId: number): Promise<TelegramUser | null> {
    const { data, error } = await this.client
      .from("telegram_users")
      .select("*")
      .eq("telegram_chat_id", chatId)
      .maybeSingle();
    if (error) throw databaseError("Unable to load Telegram registration", error);
    return data as TelegramUser | null;
  }

  async upsertTelegramRegistration(registration: TelegramRegistration): Promise<TelegramUser> {
    const { data, error } = await this.client
      .from("telegram_users")
      .upsert(registration, { onConflict: "telegram_chat_id" })
      .select("*")
      .single();
    if (error) throw databaseError("Unable to save Telegram registration", error);
    return data as TelegramUser;
  }

  async updateUser(id: number, update: UserUpdate): Promise<TelegramUser | null> {
    const { data, error } = await this.client
      .from("telegram_users")
      .update(update)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw databaseError("Unable to update Telegram user", error);
    return data as TelegramUser | null;
  }

  async findRecipientsForNotification(preference: NotificationPreference): Promise<TelegramUser[]> {
    const { data, error } = await this.client
      .from("telegram_users")
      .select("*")
      .eq("active", true)
      .eq(preference, true);
    if (error) throw databaseError("Unable to resolve notification recipients", error);
    return (data ?? []) as TelegramUser[];
  }
}
