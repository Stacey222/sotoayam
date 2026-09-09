import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CRITICAL_ALERT_POLICY } from "../../src/alerts/policy.js";
import { buildApp } from "../../src/app.js";
import { isAdminRouteScope } from "../../src/auth/admin-authorization.js";
import type { AppConfig } from "../../src/config/env.js";
import { adminNotificationsRoutes } from "../../src/routes/admin-notifications.routes.js";
import { adminUserManagementRoutes } from "../../src/routes/admin-user-management.routes.js";
import { collaborationRulesRoutes } from "../../src/routes/collaboration-rules.routes.js";
import { adminCriticalAlertRoutes, criticalAlertsRoutes } from "../../src/routes/critical-alerts.routes.js";
import { integrationAdministrationRoutes } from "../../src/routes/integration-administration.routes.js";
import { reportsRoutes } from "../../src/routes/reports.routes.js";
import { systemAuthorityRoutes } from "../../src/routes/system-authority.routes.js";
import { internalTaskIngestionRoutes, csvImportRoutes } from "../../src/routes/task-ingestion.routes.js";
import { tasksRoutes } from "../../src/routes/tasks.routes.js";
import { usersRoutes } from "../../src/routes/users.routes.js";
import { taxonomyRoutes } from "../../src/routes/taxonomy.routes.js";

const config: AppConfig = {
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "test-service-key",
  telegramBotToken: "test-bot-token",
  internalApiKey: "test-internal-key",
  adminApiKey: "a".repeat(32),
  port: 3000,
  telegramPollingEnabled: false,
  reminderSchedulerEnabled: false,
  reminderSchedulerIntervalSeconds: 300,
  businessTimeZone: "Asia/Jakarta",
  criticalAlertEvaluatorEnabled: false,
  criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY,
  logLevel: "silent",
};

const repository = {
  findAll: async () => [],
  findById: async () => null,
  findByTelegramChatId: async () => null,
  upsertTelegramRegistration: vi.fn(),
  updateUser: async () => null,
  findRecipientsForNotification: async () => [],
};

const adminRouteGroups = [
  usersRoutes,
  adminUserManagementRoutes,
  systemAuthorityRoutes,
  collaborationRulesRoutes,
  integrationAdministrationRoutes,
  tasksRoutes,
  csvImportRoutes,
  adminNotificationsRoutes,
  reportsRoutes,
  criticalAlertsRoutes,
  adminCriticalAlertRoutes,
  taxonomyRoutes,
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  }));
  return nested.flat();
}

describe("admin route boundaries", () => {
  it("keeps health and the static root public", async () => {
    const { app } = await buildApp({
      config,
      repository: repository as never,
      telegramSender: { sendMessage: vi.fn().mockResolvedValue(undefined) },
      logger: false,
    });
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("keeps notification intake on internal-key authentication", async () => {
    const { app } = await buildApp({
      config,
      repository: repository as never,
      telegramSender: { sendMessage: vi.fn().mockResolvedValue(undefined) },
      logger: false,
    });
    const payload = { type: "UNKNOWN", message: "test" };
    try {
      const internal = await app.inject({
        method: "POST",
        url: "/api/notifications/send",
        headers: { "x-internal-api-key": config.internalApiKey },
        payload,
      });
      const adminOnly = await app.inject({
        method: "POST",
        url: "/api/notifications/send",
        headers: { "x-admin-api-key": config.adminApiKey },
        payload,
      });

      expect(internal.statusCode).not.toBe(401);
      expect(internal.json().error.code).toBe("VALIDATION_ERROR");
      expect(adminOnly.statusCode).toBe(401);
      expect(adminOnly.json().error.code).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
    }
  });

  it("keeps task ingestion on internal-key and integration authentication", async () => {
    const app = Fastify({ logger: false });
    await app.register(internalTaskIngestionRoutes, {
      service: { ingestAutomation: vi.fn() } as never,
      integrations: { findActiveByCode: vi.fn(), hasActiveCapability: vi.fn() },
      internalApiKey: config.internalApiKey,
    });
    const payload = { title: "Task", owner_division: "IT" };
    try {
      const internal = await app.inject({
        method: "POST",
        url: "/tasks",
        headers: { "x-internal-api-key": config.internalApiKey },
        payload,
      });
      const adminOnly = await app.inject({
        method: "POST",
        url: "/tasks",
        headers: { "x-admin-api-key": config.adminApiKey },
        payload,
      });

      expect(internal.statusCode).toBe(401);
      expect(internal.json().code).toBe("INTEGRATION_REQUIRED");
      expect(adminOnly.statusCode).toBe(401);
      expect(adminOnly.json().code).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
    }
  });

  it("marks every admin route group as a centralized admin scope", () => {
    expect(adminRouteGroups).toHaveLength(12);
    for (const routes of adminRouteGroups) expect(isAdminRouteScope(routes)).toBe(true);
  });

  it("keeps the tested manifest in parity with app registrations", async () => {
    const appSource = await readFile(path.resolve("src/app.ts"), "utf8");
    expect(appSource.match(/adminApiKey:/g) ?? []).toHaveLength(adminRouteGroups.length);
  });

  it("keeps the admin API-key header in one source file", async () => {
    const sourceRoot = path.resolve("src");
    const matchingFiles: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      if ((await readFile(file, "utf8")).includes("x-admin-api-key")) {
        matchingFiles.push(path.relative(sourceRoot, file).replaceAll("\\", "/"));
      }
    }
    expect(matchingFiles).toEqual(["auth/admin-authorization.ts"]);
  });
});
