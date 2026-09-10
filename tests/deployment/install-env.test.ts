import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const installScript = path.join(projectRoot, "scripts/deploy/install-env.sh");
const bashCommand = process.platform === "win32"
  ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git/bin/bash.exe")
  : "bash";
const temporaryDirectories: string[] = [];

function bashPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

function environmentText(overrides: Record<string, string> = {}): string {
  const values = {
    SUPABASE_URL: "https://customer-project.example",
    SUPABASE_SERVICE_ROLE_KEY: "test-server-key",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    INTERNAL_API_KEY: "test-internal-key",
    INTERNAL_API_KEY_FALLBACK_ENABLED: "true",
    ADMIN_API_KEY: "test-admin-key-with-sufficient-length-123456",
    ADMIN_API_KEY_FALLBACK_ENABLED: "false",
    HOST: "127.0.0.1",
    PORT: "3000",
    TELEGRAM_POLLING_ENABLED: "true",
    REMINDER_SCHEDULER_ENABLED: "true",
    REMINDER_SCHEDULER_INTERVAL_SECONDS: "300",
    BUSINESS_TIME_ZONE: "UTC",
    CRITICAL_ALERT_EVALUATOR_ENABLED: "true",
    LOG_LEVEL: "info",
    ...overrides,
  };
  return `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}

async function runInstaller(input: string) {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "sotoayam-install-env-"));
  temporaryDirectories.push(appRoot);
  await mkdir(path.join(appRoot, "shared"));
  const result = spawnSync(bashCommand, [bashPath(installScript)], {
    encoding: "utf8",
    input,
    env: { ...process.env, APP_ROOT: bashPath(appRoot) },
  });
  return { appRoot, result };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runtime environment installation", () => {
  it("accepts explicit operational flags enabled for a fresh customer", async () => {
    const { appRoot, result } = await runInstaller(environmentText());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("RUNTIME_FLAG_CONFIGURATION=PASS");
    expect(await readFile(path.join(appRoot, "shared", ".env"), "utf8"))
      .toContain("TELEGRAM_POLLING_ENABLED=true");
  });

  it("accepts explicit all-disabled flags for staged compatibility", async () => {
    const { result } = await runInstaller(environmentText({
      TELEGRAM_POLLING_ENABLED: "false",
      REMINDER_SCHEDULER_ENABLED: "false",
      CRITICAL_ALERT_EVALUATOR_ENABLED: "false",
    }));
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts no administrator key by default and requires it for explicit fallback", async () => {
    const withoutKey = environmentText({ ADMIN_API_KEY: "" }).replace("ADMIN_API_KEY=\n", "");
    expect((await runInstaller(withoutKey)).result.status).toBe(0);
    const enabled = environmentText({ ADMIN_API_KEY: "", ADMIN_API_KEY_FALLBACK_ENABLED: "true" })
      .replace("ADMIN_API_KEY=\n", "");
    const rejected = await runInstaller(enabled);
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stderr).toContain("ADMIN_API_KEY is required when ADMIN_API_KEY_FALLBACK_ENABLED=true");
  });

  it("rejects invalid operational flag values", async () => {
    const { result } = await runInstaller(environmentText({ TELEGRAM_POLLING_ENABLED: "sometimes" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TELEGRAM_POLLING_ENABLED must be true or false");
  });

  it("rejects an enabled evaluator when the scheduler is disabled", async () => {
    const { result } = await runInstaller(environmentText({
      REMINDER_SCHEDULER_ENABLED: "false",
      CRITICAL_ALERT_EVALUATOR_ENABLED: "true",
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CRITICAL_ALERT_EVALUATOR_ENABLED requires REMINDER_SCHEDULER_ENABLED");
  });
});
