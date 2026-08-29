import "dotenv/config";

export interface SupabaseConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export interface AppConfig extends SupabaseConfig {
  telegramBotToken: string;
  internalApiKey: string;
  adminApiKey?: string;
  port: number;
  telegramPollingEnabled: boolean;
  logLevel: string;
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

export function loadConfig(): AppConfig {
  const supabase = loadSupabaseConfig();
  return {
    ...supabase,
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    internalApiKey: requireEnv("INTERNAL_API_KEY"),
    adminApiKey: process.env.ADMIN_API_KEY?.trim() || undefined,
    port: parsePort(process.env.PORT),
    telegramPollingEnabled: process.env.TELEGRAM_POLLING_ENABLED !== "false",
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
  };
}

export function loadSupabaseConfig(): SupabaseConfig {
  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabaseServiceRoleKey: requireSupabaseServerKey(),
  };
}
