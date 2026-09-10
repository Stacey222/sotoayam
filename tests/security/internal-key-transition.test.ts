import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { InternalApiKeyFallbackObserver } from "../../src/auth/internal-integration-authorization.js";
import { loadConfig } from "../../src/config/env.js";
import { internalTaskIngestionRoutes } from "../../src/routes/task-ingestion.routes.js";

const payload = { title: "Task", owner_division: "OPS" };

async function legacyApp(enabled: boolean) {
  const app = Fastify({ logger: false });
  const ingestAutomation = vi.fn().mockResolvedValue({ accepted: true });
  await app.register(internalTaskIngestionRoutes, { service: { ingestAutomation } as never,
    integrations: { findActiveByCode: vi.fn().mockResolvedValue({ id: 7, code: "SYNC", name: "Sync",
      source: "AUTOMATION", requesting_division_id: 2, active: true }), hasActiveCapability: vi.fn().mockResolvedValue(true) },
    internalApiKey: "legacy-key", internalApiKeyFallbackEnabled: enabled });
  return { app, ingestAutomation };
}

describe("P1-04 shared-key transitions", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test-only");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("INTERNAL_API_KEY", "test-internal-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("P4-24 keeps legacy internal key plus integration code working while fallback is enabled", async () => {
    const { app, ingestAutomation } = await legacyApp(true);
    try { const response = await app.inject({ method: "POST", url: "/tasks", headers: {
      "x-internal-api-key": "legacy-key", "x-integration-code": "SYNC" }, payload });
      expect(response.statusCode).toBe(200); expect(ingestAutomation).toHaveBeenCalledOnce(); } finally { await app.close(); }
  });

  it("P4-25 refuses the legacy internal key when fallback is disabled", async () => {
    const { app, ingestAutomation } = await legacyApp(false);
    try { const response = await app.inject({ method: "POST", url: "/tasks", headers: {
      "x-internal-api-key": "legacy-key", "x-integration-code": "SYNC" }, payload });
      expect(response.statusCode).toBe(401); expect(ingestAutomation).not.toHaveBeenCalled(); } finally { await app.close(); }
  });

  it("P4-26 logs and audits internal fallback use once per process", async () => {
    const append = vi.fn().mockResolvedValue({}); const warn = vi.fn();
    const observer = new InternalApiKeyFallbackObserver({ append } as never, warn);
    await observer.observe(); await observer.observe();
    expect(warn).toHaveBeenCalledOnce(); expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "INTERNAL_API_KEY_FALLBACK_USED" }));
  });

  it("P4-27 defaults admin fallback off, preserves explicit opt-in, and warns at startup", async () => {
    vi.stubEnv("ADMIN_API_KEY", undefined); vi.stubEnv("ADMIN_API_KEY_FALLBACK_ENABLED", undefined);
    expect(loadConfig().adminApiKeyFallbackEnabled).toBe(false);
    vi.stubEnv("ADMIN_API_KEY", "a".repeat(32)); vi.stubEnv("ADMIN_API_KEY_FALLBACK_ENABLED", "true");
    expect(loadConfig()).toMatchObject({ adminApiKeyFallbackEnabled: true, adminApiKey: "a".repeat(32) });
    const appSource = await readFile(path.resolve("src/app.ts"), "utf8");
    expect(appSource).toMatch(/adminApiKeyFallbackEnabled[\s\S]*app\.log\.warn\("ADMIN_API_KEY compatibility fallback is enabled and deprecated/);
  });

  it("P4-28 accepts an absent admin key, rejects short present values, and requires it for fallback", () => {
    vi.stubEnv("ADMIN_API_KEY", undefined); vi.stubEnv("ADMIN_API_KEY_FALLBACK_ENABLED", "false");
    expect(loadConfig().adminApiKey).toBeUndefined();
    vi.stubEnv("ADMIN_API_KEY", "short");
    expect(() => loadConfig()).toThrow("ADMIN_API_KEY must be at least 32 characters");
    vi.stubEnv("ADMIN_API_KEY", undefined); vi.stubEnv("ADMIN_API_KEY_FALLBACK_ENABLED", "true");
    expect(() => loadConfig()).toThrow("ADMIN_API_KEY when ADMIN_API_KEY_FALLBACK_ENABLED=true");
  });
});
