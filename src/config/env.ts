import "dotenv/config";
import { parseCriticalAlertPolicy, type CriticalAlertPolicy } from "../alerts/policy.js";

export interface SupabaseConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export interface AppConfig extends SupabaseConfig {
  telegramBotToken: string;
  internalApiKey: string;
  adminApiKey?: string;
  host?: string;
  port: number;
  telegramPollingEnabled: boolean;
  reminderSchedulerEnabled: boolean;
  reminderSchedulerIntervalSeconds: number;
  businessTimeZone: string;
  criticalAlertEvaluatorEnabled: boolean;
  criticalAlertPolicy: CriticalAlertPolicy;
  apiRateLimitWindowSeconds: number;
  apiRateLimitMaxRequests: number;
  apiRateLimitMaxTrackedClients: number;
  logLevel: string;
}

function parseHost(value: string | undefined): string {
  const host = value?.trim() || "0.0.0.0";
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

function parseBoundedPositiveInteger(value: string | undefined, fallback: number, name: string, max: number): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`Invalid environment variable: ${name}`);
  return parsed;
}

function parseBusinessTimeZone(value: string | undefined): string {
  const timeZone = value?.trim() || "Asia/Jakarta";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error("Invalid environment variable: BUSINESS_TIME_ZONE");
  }
  return timeZone;
}

export function loadConfig(): AppConfig {
  const supabase = loadSupabaseConfig();
  const config: AppConfig = {
    ...supabase,
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    internalApiKey: requireEnv("INTERNAL_API_KEY"),
    adminApiKey: process.env.ADMIN_API_KEY?.trim() || undefined,
    host: parseHost(process.env.HOST),
    port: parsePort(process.env.PORT),
    telegramPollingEnabled: process.env.TELEGRAM_POLLING_ENABLED === "true",
    reminderSchedulerEnabled: process.env.REMINDER_SCHEDULER_ENABLED === "true",
    reminderSchedulerIntervalSeconds: parseSchedulerInterval(process.env.REMINDER_SCHEDULER_INTERVAL_SECONDS),
    businessTimeZone: parseBusinessTimeZone(process.env.BUSINESS_TIME_ZONE),
    criticalAlertEvaluatorEnabled: process.env.CRITICAL_ALERT_EVALUATOR_ENABLED === "true",
    criticalAlertPolicy: parseCriticalAlertPolicy(process.env.CRITICAL_ALERT_POLICY_JSON),
    apiRateLimitWindowSeconds: parseBoundedPositiveInteger(process.env.API_RATE_LIMIT_WINDOW_SECONDS, 60, "API_RATE_LIMIT_WINDOW_SECONDS", 3600),
    apiRateLimitMaxRequests: parseBoundedPositiveInteger(process.env.API_RATE_LIMIT_MAX_REQUESTS, 120, "API_RATE_LIMIT_MAX_REQUESTS", 100_000),
    apiRateLimitMaxTrackedClients: parseBoundedPositiveInteger(process.env.API_RATE_LIMIT_MAX_TRACKED_CLIENTS, 10_000, "API_RATE_LIMIT_MAX_TRACKED_CLIENTS", 1_000_000),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
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
