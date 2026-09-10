import "dotenv/config";
import { parseCriticalAlertPolicy, type CriticalAlertPolicy } from "../alerts/policy.js";

export interface SupabaseConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export interface AppConfig extends SupabaseConfig {
  telegramBotToken: string;
  internalApiKey: string;
  adminApiKey: string;
  host?: string;
  port: number;
  telegramPollingEnabled: boolean;
  reminderSchedulerEnabled: boolean;
  reminderSchedulerIntervalSeconds: number;
  businessTimeZone: string;
  criticalAlertEvaluatorEnabled: boolean;
  criticalAlertPolicy: CriticalAlertPolicy;
  logLevel: string;
  sessionAbsoluteTtlSeconds: number;
  sessionIdleTtlSeconds: number;
  sessionCookieSecure: boolean;
  trustProxy: boolean;
  adminApiKeyFallbackEnabled: boolean;
  rateLimitEnabled: boolean;
  rateLimitLoginPerMinute: number;
  rateLimitLoginGlobalPerMinute: number;
  rateLimitAdminReadPerMinute: number;
  rateLimitAdminWritePerMinute: number;
  rateLimitAdminExpensivePerMinute: number;
  rateLimitInternalPerMinute: number;
  rateLimitAuthFailurePerMinute: number;
  rateLimitSharedOriginFactor: number;
  rateLimitMaxKeys: number;
  rateLimitTrustedIps: string[];
}

function parseHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (host.length > 253 || !/^[A-Za-z0-9.:-]+$/.test(host)) {
    throw new Error("Invalid environment variable: HOST");
  }
  return host;
}

function requireEnv(name: string, aliases: string[] = []): string {
  for (const candidate of [name, ...aliases]) {
    const value = process.env[candidate]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: ${name}`);
}

function requireMinimumLengthEnv(name: string, minimumLength: number): string {
  const value = requireEnv(name);
  if (value.length < minimumLength) {
    throw new Error(`Invalid environment variable: ${name} must be at least ${minimumLength} characters`);
  }
  return value;
}

function requireSupabaseServerKey(): string {
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY", ["SUPABASE_SERVICE_KEY"]);
  let isServerKey = key.startsWith("sb_secret_");
  if (!isServerKey && key.split(".").length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8")) as {
        role?: unknown;
      };
      isServerKey = payload.role === "service_role";
    } catch {
      isServerKey = false;
    }
  }
  if (!isServerKey) {
    throw new Error("Invalid server credential: SUPABASE_SERVICE_ROLE_KEY must be a service role or secret key");
  }
  return key;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid environment variable: PORT");
  }
  return port;
}

function parseSchedulerInterval(value: string | undefined): number {
  const seconds = Number(value?.trim() || "300");
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) {
    throw new Error("Invalid environment variable: REMINDER_SCHEDULER_INTERVAL_SECONDS");
  }
  return seconds;
}

function parseBoolean(name: string, value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid environment variable: ${name}`);
}

function parseBoundedInteger(name: string, value: string | undefined, defaultValue: number, minimum: number, maximum: number): number {
  const parsed = Number(value?.trim() || defaultValue);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid environment variable: ${name}`);
  }
  return parsed;
}

function isLoopbackHost(host: string | undefined): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function parseBusinessTimeZone(value: string | undefined): string {
  const timeZone = value?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error("Invalid environment variable: BUSINESS_TIME_ZONE");
  }
  return timeZone;
}

export function loadConfig(): AppConfig {
  const supabase = loadSupabaseConfig();
  const host = parseHost(process.env.HOST);
  const sessionAbsoluteTtlSeconds = parseBoundedInteger("SESSION_ABSOLUTE_TTL_SECONDS",
    process.env.SESSION_ABSOLUTE_TTL_SECONDS, 43_200, 900, 604_800);
  const sessionIdleTtlSeconds = parseBoundedInteger("SESSION_IDLE_TTL_SECONDS",
    process.env.SESSION_IDLE_TTL_SECONDS, 3_600, 300, sessionAbsoluteTtlSeconds);
  const sessionCookieSecure = parseBoolean("SESSION_COOKIE_SECURE", process.env.SESSION_COOKIE_SECURE, true);
  const trustProxy = parseBoolean("TRUST_PROXY", process.env.TRUST_PROXY, false);
  if (!sessionCookieSecure && (!isLoopbackHost(host) || trustProxy)) {
    throw new Error("Invalid environment: SESSION_COOKIE_SECURE=false requires a loopback HOST and TRUST_PROXY=false");
  }
  const config: AppConfig = {
    ...supabase,
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    internalApiKey: requireEnv("INTERNAL_API_KEY"),
    adminApiKey: requireMinimumLengthEnv("ADMIN_API_KEY", 32),
    host,
    port: parsePort(process.env.PORT),
    telegramPollingEnabled: process.env.TELEGRAM_POLLING_ENABLED === "true",
    reminderSchedulerEnabled: process.env.REMINDER_SCHEDULER_ENABLED === "true",
    reminderSchedulerIntervalSeconds: parseSchedulerInterval(process.env.REMINDER_SCHEDULER_INTERVAL_SECONDS),
    businessTimeZone: parseBusinessTimeZone(process.env.BUSINESS_TIME_ZONE),
    criticalAlertEvaluatorEnabled: process.env.CRITICAL_ALERT_EVALUATOR_ENABLED === "true",
    criticalAlertPolicy: parseCriticalAlertPolicy(process.env.CRITICAL_ALERT_POLICY_JSON),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    sessionAbsoluteTtlSeconds,
    sessionIdleTtlSeconds,
    sessionCookieSecure,
    trustProxy,
    adminApiKeyFallbackEnabled: parseBoolean("ADMIN_API_KEY_FALLBACK_ENABLED", process.env.ADMIN_API_KEY_FALLBACK_ENABLED, true),
    rateLimitEnabled: parseBoolean("RATE_LIMIT_ENABLED", process.env.RATE_LIMIT_ENABLED, true),
    rateLimitLoginPerMinute: parseBoundedInteger("RATE_LIMIT_LOGIN_PER_MINUTE", process.env.RATE_LIMIT_LOGIN_PER_MINUTE, 5, 1, 120),
    rateLimitLoginGlobalPerMinute: parseBoundedInteger("RATE_LIMIT_LOGIN_GLOBAL_PER_MINUTE", process.env.RATE_LIMIT_LOGIN_GLOBAL_PER_MINUTE, 60, 10, 6_000),
    rateLimitAdminReadPerMinute: parseBoundedInteger("RATE_LIMIT_ADMIN_READ_PER_MINUTE", process.env.RATE_LIMIT_ADMIN_READ_PER_MINUTE, 300, 30, 6_000),
    rateLimitAdminWritePerMinute: parseBoundedInteger("RATE_LIMIT_ADMIN_WRITE_PER_MINUTE", process.env.RATE_LIMIT_ADMIN_WRITE_PER_MINUTE, 60, 5, 1_200),
    rateLimitAdminExpensivePerMinute: parseBoundedInteger("RATE_LIMIT_ADMIN_EXPENSIVE_PER_MINUTE", process.env.RATE_LIMIT_ADMIN_EXPENSIVE_PER_MINUTE, 10, 1, 600),
    rateLimitInternalPerMinute: parseBoundedInteger("RATE_LIMIT_INTERNAL_PER_MINUTE", process.env.RATE_LIMIT_INTERNAL_PER_MINUTE, 600, 30, 20_000),
    rateLimitAuthFailurePerMinute: parseBoundedInteger("RATE_LIMIT_AUTH_FAILURE_PER_MINUTE", process.env.RATE_LIMIT_AUTH_FAILURE_PER_MINUTE, 30, 3, 600),
    rateLimitSharedOriginFactor: parseBoundedInteger("RATE_LIMIT_SHARED_ORIGIN_FACTOR", process.env.RATE_LIMIT_SHARED_ORIGIN_FACTOR, 10, 1, 100),
    rateLimitMaxKeys: parseBoundedInteger("RATE_LIMIT_MAX_KEYS", process.env.RATE_LIMIT_MAX_KEYS, 10_000, 1_000, 200_000),
    rateLimitTrustedIps: (process.env.RATE_LIMIT_TRUSTED_IPS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  };
  if (config.criticalAlertEvaluatorEnabled && !config.reminderSchedulerEnabled) {
    throw new Error("Invalid environment: CRITICAL_ALERT_EVALUATOR_ENABLED requires REMINDER_SCHEDULER_ENABLED");
  }
  return config;
}

export function loadSupabaseConfig(): SupabaseConfig {
  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabaseServiceRoleKey: requireSupabaseServerKey(),
  };
}
