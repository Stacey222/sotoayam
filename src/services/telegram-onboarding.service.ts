import { generateOpaqueToken, hashOpaqueToken } from "../auth/admin-session.js";
import { AppError, DatabaseError } from "../errors.js";
import { NOTIFICATION_PREFERENCE_BY_TYPE, type TelegramUser } from "../types/index.js";
import type { SupabaseTelegramOnboardingRepository } from "../repositories/telegram-onboarding.repository.js";

const TYPES = Object.keys(NOTIFICATION_PREFERENCE_BY_TYPE);
const TTL_MS = 10 * 60 * 1000;

export class TelegramOnboardingService {
  constructor(private readonly repository: SupabaseTelegramOnboardingRepository,
    private readonly botUsername?: string) {}

  async createPairing(userId: number) {
    if (!this.botUsername) throw new AppError(503, "TELEGRAM_ONBOARDING_UNAVAILABLE",
      "Telegram bot username is not configured");
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    await this.repository.createPairing(userId, hashOpaqueToken(token), expiresAt);
    return { bot_username: this.botUsername, deep_link: `https://t.me/${this.botUsername}?start=${token}`,
      expires_at: expiresAt };
  }

  async consume(token: string, chatId: number, username: string | null, firstName: string | null): Promise<TelegramUser> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new AppError(400, "TELEGRAM_PAIRING_INVALID_OR_EXPIRED",
      "Telegram pairing is invalid or expired");
    try { return await this.repository.consumePairing(hashOpaqueToken(token), chatId, username, firstName); }
    catch (error) {
      const message = error instanceof DatabaseError ? error.diagnostic.message ?? "" : "";
      if (message.includes("ALREADY_CONNECTED")) throw new AppError(409, "TELEGRAM_ALREADY_CONNECTED",
        "This Telegram account or Sotoayam user is already connected");
      if (message.includes("PAIRING_INVALID_OR_EXPIRED") || message.includes("PAIRING_USER_UNAVAILABLE")) {
        throw new AppError(400, "TELEGRAM_PAIRING_INVALID_OR_EXPIRED", "Telegram pairing is invalid or expired");
      }
      throw error;
    }
  }

  async state(userId: number) {
    const state = await this.repository.state(userId);
    return { ...state, bot_username: this.botUsername ?? null,
      supported_types: TYPES,
      readiness: { owner_account: state.ownerAccountReady, business_settings: state.businessSettingsReady,
        telegram_connected: state.connected && state.verified,
        preferences_reviewed: state.preferencesReviewed, test_notification_sent: state.testNotificationSent } };
  }

  async updatePreferences(userId: number, input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError(400, "VALIDATION_ERROR",
      "All notification preferences are required");
    const values = input as Record<string, unknown>;
    if (Object.keys(values).length !== TYPES.length || TYPES.some((type) => typeof values[type] !== "boolean")
      || Object.keys(values).some((type) => !TYPES.includes(type))) throw new AppError(400, "VALIDATION_ERROR",
      "All seven supported notification preferences are required");
    return this.repository.updatePreferences(userId, values as Record<string, boolean>);
  }
}
