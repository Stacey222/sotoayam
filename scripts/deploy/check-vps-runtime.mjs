import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_RUNTIME_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TELEGRAM_BOT_TOKEN",
  "INTERNAL_API_KEY",
  "INTERNAL_API_KEY_FALLBACK_ENABLED",
  "ADMIN_API_KEY_FALLBACK_ENABLED",
  "HOST",
  "PORT",
  "TELEGRAM_POLLING_ENABLED",
  "REMINDER_SCHEDULER_ENABLED",
  "REMINDER_SCHEDULER_INTERVAL_SECONDS",
  "BUSINESS_TIME_ZONE",
  "CRITICAL_ALERT_EVALUATOR_ENABLED",
  "LOG_LEVEL",
];
const BOOLEAN_RUNTIME_ENV = [
  "TELEGRAM_POLLING_ENABLED",
  "REMINDER_SCHEDULER_ENABLED",
  "CRITICAL_ALERT_EVALUATOR_ENABLED",
  "INTERNAL_API_KEY_FALLBACK_ENABLED",
  "ADMIN_API_KEY_FALLBACK_ENABLED",
];

export function validateRuntimeEnvironment(environment) {
  const missing = REQUIRED_RUNTIME_ENV.filter((name) => !environment[name]?.trim());
  const invalid = BOOLEAN_RUNTIME_ENV.filter((name) => !["true", "false"].includes(environment[name] ?? ""));
  const port = Number(environment.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid.push("PORT");
  if (environment.HOST !== "127.0.0.1") invalid.push("HOST");
  if (environment.CRITICAL_ALERT_EVALUATOR_ENABLED === "true" && environment.REMINDER_SCHEDULER_ENABLED !== "true") {
    invalid.push("CRITICAL_ALERT_EVALUATOR_ENABLED");
  }
  const adminKey = environment.ADMIN_API_KEY?.trim();
  if (adminKey && adminKey.length < 32) invalid.push("ADMIN_API_KEY");
  if (environment.ADMIN_API_KEY_FALLBACK_ENABLED === "true" && !adminKey) missing.push("ADMIN_API_KEY");
  return { missing, invalid: [...new Set(invalid)] };
}

export async function checkVpsRuntime(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const nodeVersion = options.nodeVersion ?? process.version;
  const versionFile = options.versionFile ?? path.resolve(".node-version");

  const configuration = validateRuntimeEnvironment(environment);
  if (configuration.missing.length > 0 || configuration.invalid.length > 0) {
    stderr(`RUNTIME_CONFIG=FAIL missing=${configuration.missing.join(",") || "none"} invalid=${configuration.invalid.join(",") || "none"}`);
    return 1;
  }
  stdout("RUNTIME_CONFIG=PASS");

  let supportedVersion;
  try {
    const pin = (await readFile(versionFile, "utf8")).trim();
    if (!/^\d+\.\d+\.\d+$/.test(pin)) throw new Error("invalid pin");
    supportedVersion = `v${pin}`;
  } catch {
    stderr("NODE_VERSION_CHECK=FAIL reason=pin-unavailable");
    return 1;
  }
  if (nodeVersion !== supportedVersion) {
    stderr(`NODE_VERSION_CHECK=FAIL expected=${supportedVersion} actual=${nodeVersion}`);
    return 1;
  }
  stdout("NODE_VERSION_CHECK=PASS");

  let response;
  try {
    response = await fetchImplementation(`http://127.0.0.1:${environment.PORT}/health`);
  } catch {
    stderr("HEALTH_CHECK=FAIL reason=unreachable");
    return 1;
  }
  const payload = await response.json().catch(() => ({}));
  if (response.status !== 200 || payload?.status !== "ok") {
    stderr(`HEALTH_CHECK=FAIL status=${response.status}`);
    return 1;
  }
  stdout("HEALTH_CHECK=PASS");
  stdout("RUNTIME_CHECK=PASS");
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (import.meta.url === invokedPath) process.exitCode = await checkVpsRuntime();
