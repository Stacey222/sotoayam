import { describe, expect, it, vi } from "vitest";
import { TelegramOnboardingService } from "../../src/services/telegram-onboarding.service.js";
import { TelegramRegistrationService } from "../../src/services/telegram-registration.service.js";
import { TelegramBot } from "../../src/telegram/bot.js";

const user = { id: 7, telegram_chat_id: 123, telegram_username: "owner", telegram_first_name: "Owner",
  name: "Owner", division: "Operations", role: "Owner", active: true,
  stock_alert: false, purchase_alert: false, sales_alert: false, marketing_alert: false,
  content_alert: false, owner_report: false, system_error: false, created_at: "now", updated_at: "now" };

describe("P3-02 customer Telegram onboarding", () => {
  it("creates a short-lived pairing whose stored value is only a SHA-256 hash", async () => {
    const repository = { createPairing: vi.fn(), state: vi.fn(), consumePairing: vi.fn(), updatePreferences: vi.fn() };
    const result = await new TelegramOnboardingService(repository as never, "sotoayam_bot").createPairing(7);
    const token = new URL(result.deep_link).searchParams.get("start")!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.createPairing).toHaveBeenCalledWith(7, expect.stringMatching(/^[0-9a-f]{64}$/), result.expires_at);
    expect(repository.createPairing.mock.calls[0]?.[1]).not.toContain(token);
    expect(new Date(result.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(600_000);
  });

  it("requires exactly the seven typed preferences", async () => {
    const repository = { createPairing: vi.fn(), state: vi.fn(), consumePairing: vi.fn(),
      updatePreferences: vi.fn().mockResolvedValue([]) };
    const service = new TelegramOnboardingService(repository as never, "sotoayam_bot");
    await expect(service.updatePreferences(7, { STOCK_CRITICAL: true })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const values = { STOCK_CRITICAL: true, PURCHASE_RECOMMENDATION: false, SALES_FOLLOWUP: true,
      MARKETING_ALERT: false, CONTENT_OPPORTUNITY: true, OWNER_DAILY_REPORT: true, SYSTEM_ERROR: true };
    await service.updatePreferences(7, values);
    expect(repository.updatePreferences).toHaveBeenCalledWith(7, values);
  });

  it("derives readiness from repository state instead of hard-coded completion flags", async () => {
    const repository = { createPairing: vi.fn(), consumePairing: vi.fn(), updatePreferences: vi.fn(),
      state: vi.fn().mockResolvedValue({ ownerAccountReady: false, businessSettingsReady: false,
        connected: false, verified: false, username: null, preferencesReviewed: false,
        preferences: [], testNotificationSent: false }) };
    const result = await new TelegramOnboardingService(repository as never, "sotoayam_bot").state(7);
    expect(result.readiness).toEqual({ owner_account: false, business_settings: false,
      telegram_connected: false, preferences_reviewed: false, test_notification_sent: false });
  });

  it("routes a private /start pairing through the bound pairing service, not legacy registration", async () => {
    const writer = { upsertTelegramRegistration: vi.fn() };
    const sender = { sendMessage: vi.fn() };
    const resolver = { resolveByLegacyTelegramUserId: vi.fn().mockResolvedValue({ status: "ACTIVE", active: true,
      divisionId: 1, roleId: 1, divisionCode: "OPERATIONS", roleCode: "OWNER" }) };
    const bot = new TelegramBot("token", new TelegramRegistrationService(writer), resolver, sender,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const consume = vi.fn().mockResolvedValue(user);
    bot.attachPairingService({ consume } as never);
    const token = "a".repeat(43);
    await bot.handleUpdate({ update_id: 1, message: { text: `/start ${token}`,
      chat: { id: 123, type: "private" }, from: { id: 123, username: "owner" } } });
    expect(consume).toHaveBeenCalledWith(token, 123, "owner", null);
    expect(writer.upsertTelegramRegistration).not.toHaveBeenCalled();
    expect(sender.sendMessage).toHaveBeenCalledWith(123, "Telegram berhasil terhubung ke akun Sotoayam Anda.");
  });

  it("rejects a malformed pairing payload instead of creating a legacy identity", async () => {
    const writer = { upsertTelegramRegistration: vi.fn() }; const sender = { sendMessage: vi.fn() };
    const bot = new TelegramBot("token", new TelegramRegistrationService(writer),
      { resolveByLegacyTelegramUserId: vi.fn() }, sender, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await bot.handleUpdate({ update_id: 2, message: { text: "/start truncated-token",
      chat: { id: 123, type: "private" }, from: { id: 123 } } });
    expect(writer.upsertTelegramRegistration).not.toHaveBeenCalled();
    expect(sender.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("tidak valid"));
  });
});
