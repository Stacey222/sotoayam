import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkVpsRuntime, validateRuntimeEnvironment } from "../../scripts/deploy/check-vps-runtime.mjs";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories = [];

const freshEnvironment = (overrides = {}) => ({
  SUPABASE_URL: "https://customer-project.example",
  SUPABASE_SERVICE_ROLE_KEY: "test-server-key",
  TELEGRAM_BOT_TOKEN: "test-bot-token",
  INTERNAL_API_KEY: "test-internal-key",
  INTERNAL_API_KEY_FALLBACK_ENABLED: "true",
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
});

async function versionFile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sotoayam-runtime-check-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, ".node-version");
  await writeFile(file, "24.20.0\n", "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("generic VPS runtime validation", () => {
  it("passes without historical users, divisions, rules, or row counts", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: "ok" }),
    });
    const output = [];

    await expect(checkVpsRuntime({
      environment: freshEnvironment(),
      fetchImplementation,
      nodeVersion: "v24.20.0",
      versionFile: await versionFile(),
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message),
    })).resolves.toBe(0);

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledWith("http://127.0.0.1:3000/health");
    expect(output).toEqual(["RUNTIME_CONFIG=PASS", "NODE_VERSION_CHECK=PASS", "HEALTH_CHECK=PASS", "RUNTIME_CHECK=PASS"]);
  });

  it("fails closed for missing or inconsistent runtime configuration", () => {
    expect(validateRuntimeEnvironment(freshEnvironment({ TELEGRAM_BOT_TOKEN: "" })).missing)
      .toContain("TELEGRAM_BOT_TOKEN");
    expect(validateRuntimeEnvironment(freshEnvironment({
      REMINDER_SCHEDULER_ENABLED: "false",
      CRITICAL_ALERT_EVALUATOR_ENABLED: "true",
    })).invalid).toContain("CRITICAL_ALERT_EVALUATOR_ENABLED");
    expect(validateRuntimeEnvironment(freshEnvironment({ INTERNAL_API_KEY_FALLBACK_ENABLED: "sometimes" })).invalid)
      .toContain("INTERNAL_API_KEY_FALLBACK_ENABLED");
    expect(validateRuntimeEnvironment(freshEnvironment({ ADMIN_API_KEY_FALLBACK_ENABLED: "true" })).missing)
      .toContain("ADMIN_API_KEY");
  });

  it("rejects an unsupported Node runtime before the health request", async () => {
    const fetchImplementation = vi.fn();
    const errors = [];
    await expect(checkVpsRuntime({
      environment: freshEnvironment(),
      fetchImplementation,
      nodeVersion: "v22.14.0",
      versionFile: await versionFile(),
      stdout: vi.fn(),
      stderr: (message) => errors.push(message),
    })).resolves.toBe(1);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(errors).toContain("NODE_VERSION_CHECK=FAIL expected=v24.20.0 actual=v22.14.0");
  });

  it("fails when health is unavailable or not healthy", async () => {
    const common = {
      environment: freshEnvironment(),
      nodeVersion: "v24.20.0",
      versionFile: await versionFile(),
      stdout: vi.fn(),
      stderr: vi.fn(),
    };
    await expect(checkVpsRuntime({ ...common, fetchImplementation: vi.fn().mockRejectedValue(new Error("offline")) }))
      .resolves.toBe(1);
    await expect(checkVpsRuntime({
      ...common,
      fetchImplementation: vi.fn().mockResolvedValue({ status: 503, json: async () => ({ status: "starting" }) }),
    })).resolves.toBe(1);
  });

  it("isolates historical taxonomy checks in an opt-in script excluded from fresh release packaging", async () => {
    const generic = await readFile(path.join(projectRoot, "scripts/deploy/check-vps-runtime.mjs"), "utf8");
    const legacy = await readFile(path.join(projectRoot, "scripts/deploy/check-legacy-staged-runtime.mjs"), "utf8");
    const packaging = await readFile(path.join(projectRoot, "scripts/deploy/package-release.ps1"), "utf8");
    expect(generic).not.toMatch(/ONPAGE_B2C|CONTENT_CREATOR|COLLABORATION_RULE_COUNT|x-admin-api-key/);
    expect(legacy).toMatch(/ONPAGE_B2C|CONTENT_CREATOR|LEGACY_STAGED/);
    expect(packaging).toContain("scripts/deploy/check-vps-runtime.mjs");
    expect(packaging).not.toContain("check-legacy-staged-runtime.mjs");
  });
});
