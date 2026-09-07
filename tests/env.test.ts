import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/env.js";

describe("Supabase server credential validation", () => {
  beforeEach(() => vi.stubEnv("ADMIN_API_KEY", "a".repeat(32)));
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

  it("uses the safe localhost default when HOST is absent", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("HOST", "");

    expect(loadConfig().host).toBe("127.0.0.1");
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

  it("keeps the critical alert evaluator disabled by default", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("CRITICAL_ALERT_EVALUATOR_ENABLED", "");
    expect(loadConfig().criticalAlertEvaluatorEnabled).toBe(false);
  });

  it("validates one normalized critical alert policy override", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("CRITICAL_ALERT_POLICY_JSON", '{"overdue":{"warningHours":2,"highHours":24,"criticalHours":72}}');
    expect(loadConfig().criticalAlertPolicy.overdue.warningHours).toBe(2);
    vi.stubEnv("CRITICAL_ALERT_POLICY_JSON", '{"overdue":{"warningHours":24,"highHours":2,"criticalHours":72}}');
    expect(() => loadConfig()).toThrow("Invalid critical alert policy ordering: overdue");
  });

  it("requires the existing scheduler when critical alert evaluation is enabled", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("CRITICAL_ALERT_EVALUATOR_ENABLED", "true");
    vi.stubEnv("REMINDER_SCHEDULER_ENABLED", "false");
    expect(() => loadConfig()).toThrow("CRITICAL_ALERT_EVALUATOR_ENABLED requires REMINDER_SCHEDULER_ENABLED");
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

  it("uses UTC when the customer business timezone is absent", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    vi.stubEnv("BUSINESS_TIME_ZONE", "");
    expect(loadConfig().businessTimeZone).toBe("UTC");
  });

  describe("ADMIN_API_KEY validation", () => {
    beforeEach(() => {
      vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
      vi.stubEnv("SUPABASE_SERVICE_KEY", "");
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
      vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    });

    it("rejects a missing admin API key", () => {
      vi.stubEnv("ADMIN_API_KEY", undefined);
      expect(() => loadConfig()).toThrow("Missing required environment variable: ADMIN_API_KEY");
    });

    it("rejects an empty admin API key", () => {
      vi.stubEnv("ADMIN_API_KEY", "");
      expect(() => loadConfig()).toThrow("Missing required environment variable: ADMIN_API_KEY");
    });

    it.each([1, 16, 31])("rejects a %i-character admin API key", (length) => {
      vi.stubEnv("ADMIN_API_KEY", "a".repeat(length));
      expect(() => loadConfig()).toThrow("Invalid environment variable: ADMIN_API_KEY must be at least 32 characters");
    });

    it("accepts an admin API key with exactly 32 characters", () => {
      vi.stubEnv("ADMIN_API_KEY", "a".repeat(32));
      expect(loadConfig().adminApiKey).toHaveLength(32);
    });

    it("accepts an admin API key longer than 32 characters", () => {
      vi.stubEnv("ADMIN_API_KEY", "a".repeat(33));
      expect(loadConfig().adminApiKey).toHaveLength(33);
    });
  });
});
