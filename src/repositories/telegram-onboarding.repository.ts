import type { SupabaseClient } from "@supabase/supabase-js";
import { governanceDatabaseError } from "./governance-database-error.js";
import type { TelegramUser } from "../types/index.js";

export interface TelegramPreferenceRow { notification_type: string; enabled: boolean }
export interface TelegramOnboardingState {
  ownerAccountReady: boolean;
  businessSettingsReady: boolean;
  connected: boolean;
  username: string | null;
  verified: boolean;
  preferencesReviewed: boolean;
  preferences: TelegramPreferenceRow[];
  testNotificationSent: boolean;
}

export class SupabaseTelegramOnboardingRepository {
  constructor(private readonly client: SupabaseClient) {}

  async createPairing(userId: number, tokenHash: string, expiresAt: string): Promise<void> {
    const { error } = await this.client.rpc("create_telegram_pairing", {
      p_user_id: userId, p_token_hash: tokenHash, p_expires_at: expiresAt,
    });
    if (error) throw governanceDatabaseError("Unable to create Telegram pairing", error);
  }

  async consumePairing(tokenHash: string, chatId: number, username: string | null,
    firstName: string | null): Promise<TelegramUser> {
    const { data, error } = await this.client.rpc("consume_telegram_pairing", {
      p_token_hash: tokenHash, p_telegram_chat_id: chatId,
      p_telegram_username: username, p_telegram_first_name: firstName,
    }).single();
    if (error) throw governanceDatabaseError("Unable to consume Telegram pairing", error);
    return data as TelegramUser;
  }

  async state(userId: number): Promise<TelegramOnboardingState> {
    const user = await this.client.from("users")
      .select("active,legacy_telegram_user_id,roles(code,active),admin_credentials(password_change_required)")
      .eq("id", userId).maybeSingle();
    if (user.error) throw governanceDatabaseError("Unable to load Telegram onboarding state", user.error);
    const settings = await this.client.rpc("get_instance_settings", {}).single();
    if (settings.error) throw governanceDatabaseError("Unable to load customer settings readiness", settings.error);
    const role = Array.isArray(user.data?.roles) ? user.data.roles[0] : user.data?.roles;
    const credential = Array.isArray(user.data?.admin_credentials)
      ? user.data.admin_credentials[0] : user.data?.admin_credentials;
    const ownerAccountReady = user.data?.active === true && role?.code === "OWNER" && role.active === true
      && credential?.password_change_required === false;
    const settingsRow = settings.data as { business_time_zone?: unknown; reminder_scheduler_interval_seconds?: unknown;
      critical_alert_policy?: unknown; business_actor_user_id?: unknown; business_actor_eligible?: unknown } | null;
    const businessSettingsReady = typeof settingsRow?.business_time_zone === "string"
      && typeof settingsRow?.reminder_scheduler_interval_seconds === "number"
      && settingsRow.critical_alert_policy != null && typeof settingsRow.business_actor_user_id === "number"
      && settingsRow.business_actor_eligible === true;
    const channel = await this.client.from("user_channels")
      .select("username,active,verified_at,notification_preferences_reviewed_at")
      .eq("user_id", userId).eq("channel_type", "TELEGRAM").eq("active", true).maybeSingle();
    if (channel.error) throw governanceDatabaseError("Unable to load Telegram channel state", channel.error);
    const legacyId = user.data?.legacy_telegram_user_id;
    if (!channel.data || legacyId == null) return { ownerAccountReady, businessSettingsReady,
      connected: false, username: null, verified: false,
      preferencesReviewed: false, preferences: [], testNotificationSent: false };
    const preferences = await this.client.from("telegram_notification_preferences")
      .select("notification_type,enabled").eq("telegram_user_id", legacyId).order("notification_type");
    if (preferences.error) throw governanceDatabaseError("Unable to load notification preferences", preferences.error);
    const test = await this.client.from("notifications")
      .select("id,notification_events!inner(external_event_id),notification_deliveries!inner(state)")
      .eq("recipient_user_id", userId).like("notification_events.external_event_id", "admin-test:%")
      .eq("notification_deliveries.state", "DELIVERED").limit(1);
    if (test.error) throw governanceDatabaseError("Unable to load test notification readiness", test.error);
    return { ownerAccountReady, businessSettingsReady, connected: true, username: channel.data.username ?? null,
      verified: channel.data.verified_at != null,
      preferencesReviewed: channel.data.notification_preferences_reviewed_at != null,
      preferences: (preferences.data ?? []) as TelegramPreferenceRow[], testNotificationSent: (test.data?.length ?? 0) > 0 };
  }

  async updatePreferences(userId: number, values: Record<string, boolean>): Promise<TelegramPreferenceRow[]> {
    const { data, error } = await this.client.rpc("update_own_telegram_preferences", {
      p_user_id: userId, p_stock: values.STOCK_CRITICAL, p_purchase: values.PURCHASE_RECOMMENDATION,
      p_sales: values.SALES_FOLLOWUP, p_marketing: values.MARKETING_ALERT,
      p_content: values.CONTENT_OPPORTUNITY, p_owner_report: values.OWNER_DAILY_REPORT,
      p_system_error: values.SYSTEM_ERROR,
    });
    if (error) throw governanceDatabaseError("Unable to update notification preferences", error);
    return data as TelegramPreferenceRow[];
  }
}
