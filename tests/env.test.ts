import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { createRateLimitPolicies } from "../src/http/rate-limit-policy.js";

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

  describe("administrator session configuration", () => {
    beforeEach(() => {
      vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
      vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    });

    it("uses the approved TTL, secure-cookie, proxy, and fallback defaults", () => {
      vi.stubEnv("SESSION_ABSOLUTE_TTL_SECONDS", "");
      vi.stubEnv("SESSION_IDLE_TTL_SECONDS", "");
      vi.stubEnv("SESSION_COOKIE_SECURE", "");
      vi.stubEnv("TRUST_PROXY", "");
      vi.stubEnv("ADMIN_API_KEY_FALLBACK_ENABLED", "");
      expect(loadConfig()).toMatchObject({ sessionAbsoluteTtlSeconds: 43_200,
        sessionIdleTtlSeconds: 3_600, sessionCookieSecure: true,
        trustProxy: false, adminApiKeyFallbackEnabled: true });
    });

    it("allows insecure development cookies only on loopback", () => {
      vi.stubEnv("SESSION_COOKIE_SECURE", "false");
      vi.stubEnv("HOST", "localhost");
      vi.stubEnv("TRUST_PROXY", "false");
      expect(loadConfig().sessionCookieSecure).toBe(false);
      vi.stubEnv("HOST", "0.0.0.0");
      expect(() => loadConfig()).toThrow("SESSION_COOKIE_SECURE=false requires a loopback HOST and TRUST_PROXY=false");
    });

    it("rejects insecure cookies when proxy trust is enabled, including on loopback", () => {
      vi.stubEnv("SESSION_COOKIE_SECURE", "false");
      vi.stubEnv("HOST", "127.0.0.1");
      vi.stubEnv("TRUST_PROXY", "true");
      expect(() => loadConfig()).toThrow("SESSION_COOKIE_SECURE=false requires a loopback HOST and TRUST_PROXY=false");
    });

    it("bounds absolute and idle session lifetimes", () => {
      vi.stubEnv("SESSION_ABSOLUTE_TTL_SECONDS", "899");
      expect(() => loadConfig()).toThrow("Invalid environment variable: SESSION_ABSOLUTE_TTL_SECONDS");
      vi.stubEnv("SESSION_ABSOLUTE_TTL_SECONDS", "900");
      vi.stubEnv("SESSION_IDLE_TTL_SECONDS", "901");
      expect(() => loadConfig()).toThrow("Invalid environment variable: SESSION_IDLE_TTL_SECONDS");
    });
  });

  describe("P1-03 rate-limit configuration", () => {
    beforeEach(() => {
      vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
      vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
    });

    it("RL-20 loads the approved defaults", () => {
      const loaded = loadConfig();
      expect(loaded).toMatchObject({ rateLimitEnabled: true, rateLimitLoginPerMinute: 5,
        rateLimitLoginGlobalPerMinute: 60, rateLimitAdminReadPerMinute: 300,
        rateLimitAdminWritePerMinute: 60, rateLimitAdminExpensivePerMinute: 10,
        rateLimitInternalPerMinute: 600, rateLimitAuthFailurePerMinute: 30,
        rateLimitSharedOriginFactor: 10, rateLimitMaxKeys: 10_000, rateLimitTrustedIps: [] });
      expect(createRateLimitPolicies(loaded).policies["auth-session"].capacity).toBe(120);
      expect(createRateLimitPolicies(loaded).policies["admin-read"].capacity).toBe(300);
    });

    it.each([
      ["RATE_LIMIT_LOGIN_PER_MINUTE", 1, 120], ["RATE_LIMIT_LOGIN_GLOBAL_PER_MINUTE", 10, 6_000],
      ["RATE_LIMIT_ADMIN_READ_PER_MINUTE", 30, 6_000], ["RATE_LIMIT_ADMIN_WRITE_PER_MINUTE", 5, 1_200],
      ["RATE_LIMIT_ADMIN_EXPENSIVE_PER_MINUTE", 1, 600], ["RATE_LIMIT_INTERNAL_PER_MINUTE", 30, 20_000],
      ["RATE_LIMIT_AUTH_FAILURE_PER_MINUTE", 3, 600], ["RATE_LIMIT_SHARED_ORIGIN_FACTOR", 1, 100],
      ["RATE_LIMIT_MAX_KEYS", 1_000, 200_000],
    ] as const)("RL-20 bounds and validates %s", (name, minimum, maximum) => {
      vi.stubEnv(name, "not-a-number"); expect(() => loadConfig()).toThrow(`Invalid environment variable: ${name}`);
      vi.stubEnv(name, String(minimum - 1)); expect(() => loadConfig()).toThrow(`Invalid environment variable: ${name}`);
      vi.stubEnv(name, String(maximum + 1)); expect(() => loadConfig()).toThrow(`Invalid environment variable: ${name}`);
      vi.stubEnv(name, String(minimum)); expect(loadConfig()).toBeDefined();
      vi.stubEnv(name, String(maximum)); expect(loadConfig()).toBeDefined();
    });

    it("RL-20 validates the kill switch and parses trusted IPs", () => {
      vi.stubEnv("RATE_LIMIT_ENABLED", "invalid");
      expect(() => loadConfig()).toThrow("Invalid environment variable: RATE_LIMIT_ENABLED");
      vi.stubEnv("RATE_LIMIT_ENABLED", "false");
      vi.stubEnv("RATE_LIMIT_TRUSTED_IPS", "127.0.0.2, 2001:db8::1");
      expect(loadConfig()).toMatchObject({ rateLimitEnabled: false,
        rateLimitTrustedIps: ["127.0.0.2", "2001:db8::1"] });
    });
  });
});
