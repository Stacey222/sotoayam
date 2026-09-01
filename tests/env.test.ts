import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/env.js";

describe("Supabase server credential validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("rejects a publishable key used as the service-role credential", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_publishable_test-only");
    vi.stubEnv("SUPABASE_SERVICE_KEY", "");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");

    expect(() => loadConfig()).toThrow(
      "Invalid server credential: SUPABASE_SERVICE_ROLE_KEY must be a service role or secret key",
    );
  });

  it("accepts a Supabase secret key without exposing it", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");

    expect(loadConfig().supabaseServiceRoleKey).toBe("sb_secret_test-only");
  });

  it("uses the compatible default host when HOST is absent", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("HOST", "");

    expect(loadConfig().host).toBe("0.0.0.0");
  });

  it("accepts an explicit localhost bind address", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("HOST", "127.0.0.1");

    expect(loadConfig().host).toBe("127.0.0.1");
  });

  it("rejects an unsafe host value", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("HOST", "127.0.0.1 / unsafe");

    expect(() => loadConfig()).toThrow("Invalid environment variable: HOST");
  });

  it("keeps the reminder scheduler disabled by default", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("REMINDER_SCHEDULER_ENABLED", "");
    vi.stubEnv("REMINDER_SCHEDULER_INTERVAL_SECONDS", "");
    expect(loadConfig()).toMatchObject({ reminderSchedulerEnabled: false, reminderSchedulerIntervalSeconds: 300 });
  });

  it("keeps Telegram polling disabled by default", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("TELEGRAM_POLLING_ENABLED", "");

    expect(loadConfig().telegramPollingEnabled).toBe(false);
  });

  it("rejects an unsafe reminder scheduler interval", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("REMINDER_SCHEDULER_INTERVAL_SECONDS", "5");
    expect(() => loadConfig()).toThrow("Invalid environment variable: REMINDER_SCHEDULER_INTERVAL_SECONDS");
  });

  it("uses and validates the canonical business timezone", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("BUSINESS_TIME_ZONE", "Asia/Jakarta");
    expect(loadConfig().businessTimeZone).toBe("Asia/Jakarta");
    vi.stubEnv("BUSINESS_TIME_ZONE", "Not/A-Time-Zone");
    expect(() => loadConfig()).toThrow("Invalid environment variable: BUSINESS_TIME_ZONE");
  });
});
