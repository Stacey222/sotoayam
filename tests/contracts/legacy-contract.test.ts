import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadSupabaseConfig, type AppConfig } from "../../src/config/env.js";
import { DEFAULT_CRITICAL_ALERT_POLICY } from "../../src/alerts/policy.js";
import { DatabaseError } from "../../src/errors.js";
import type { TelegramUsersRepository } from "../../src/repositories/telegram-users.repository.js";
import { NotificationService } from "../../src/services/notification.service.js";
import { RecipientResolverService } from "../../src/services/recipient-resolver.service.js";
import type { TelegramSender } from "../../src/services/telegram.service.js";
import { TelegramRegistrationService } from "../../src/services/telegram-registration.service.js";
import { TelegramBot } from "../../src/telegram/bot.js";
import {
  NOTIFICATION_PREFERENCE_BY_TYPE,
  type NotificationPreference,
  type TelegramRegistration,
  type TelegramUser,
  type UserFilters,
  type UserUpdate,
} from "../../src/types/index.js";

const config: AppConfig = {
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "contract-test-key",
  telegramBotToken: "contract-telegram-token",
  internalApiKey: "contract-internal-key",
  adminApiKey: "contract-admin-key",
  port: 3000,
  telegramPollingEnabled: false,
  reminderSchedulerEnabled: false,
  reminderSchedulerIntervalSeconds: 300,
  businessTimeZone: "Asia/Jakarta",
  criticalAlertEvaluatorEnabled: false,
  criticalAlertPolicy: DEFAULT_CRITICAL_ALERT_POLICY,
  logLevel: "silent",
  sessionAbsoluteTtlSeconds: 43_200, sessionIdleTtlSeconds: 3_600,
  sessionCookieSecure: false, trustProxy: false, adminApiKeyFallbackEnabled: true,
};

function makeUser(overrides: Partial<TelegramUser> = {}): TelegramUser {
  return {
    id: 1,
    telegram_chat_id: 1001,
    telegram_username: "legacy_user",
    telegram_first_name: "Legacy",
    name: "Legacy User",
    division: "Purchasing",
    role: "Staff",
    active: false,
    stock_alert: false,
    purchase_alert: false,
    sales_alert: false,
    marketing_alert: false,
    content_alert: false,
    owner_report: false,
    system_error: false,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

class ContractRepository implements TelegramUsersRepository {
  registrationCalls: TelegramRegistration[] = [];
  lastPreference?: NotificationPreference;

  constructor(public users: TelegramUser[] = []) {}

  async findAll(filters: UserFilters = {}): Promise<TelegramUser[]> {
    return this.users.filter((user) => {
      if (filters.status === "pending" && (user.division !== "UNASSIGNED" || user.active)) return false;
      if (filters.status === "active" && !user.active) return false;
      if (filters.status === "inactive" && (user.active || user.division === "UNASSIGNED")) return false;
      if (filters.division && user.division !== filters.division) return false;
      if (filters.active !== undefined && user.active !== filters.active) return false;
      return true;
    });
  }

  async findById(id: number): Promise<TelegramUser | null> {
    return this.users.find((user) => user.id === id) ?? null;
  }

  async findByTelegramChatId(chatId: number): Promise<TelegramUser | null> {
    return this.users.find((user) => user.telegram_chat_id === chatId) ?? null;
  }

  async upsertTelegramRegistration(registration: TelegramRegistration): Promise<TelegramUser> {
    this.registrationCalls.push({ ...registration });
    const existing = await this.findByTelegramChatId(registration.telegram_chat_id);
    if (existing) {
      existing.telegram_username = registration.telegram_username;
      existing.telegram_first_name = registration.telegram_first_name;
      return existing;
    }
    const created = makeUser({
      id: this.users.length + 1,
      ...registration,
      name: null,
      division: "UNASSIGNED",
      role: "UNASSIGNED",
      active: false,
    });
    this.users.push(created);
    return created;
  }

  async updateUser(id: number, update: UserUpdate): Promise<TelegramUser | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    Object.assign(existing, update);
    return existing;
  }

  async findRecipientsForNotification(preference: NotificationPreference): Promise<TelegramUser[]> {
    this.lastPreference = preference;
    return this.users.filter((user) => user.active && user[preference]);
  }
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("LEGACY COMPATIBILITY CONTRACT — Telegram registration", () => {
  it("registers a new /start user and sends the established success response", async () => {
    const repository = new ContractRepository();
    const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const accessStateResolver = { resolveByLegacyTelegramUserId: vi.fn().mockResolvedValue({
      status: "PENDING" as const, active: false, divisionId: null, roleId: null, divisionCode: null, roleCode: null,
    }) };
    const bot = new TelegramBot("contract-token", new TelegramRegistrationService(repository), accessStateResolver, sender, logger());

    await bot.handleUpdate({
      update_id: 10,
      message: {
        text: "/start",
        chat: { id: 2001 },
        from: { username: "new_user", first_name: "Baru" },
      },
    });

    expect(repository.registrationCalls).toEqual([{
      telegram_chat_id: 2001,
      telegram_username: "new_user",
      telegram_first_name: "Baru",
    }]);
    expect(repository.users[0]).toMatchObject({ division: "UNASSIGNED", role: "UNASSIGNED", active: false });
    expect(sender.sendMessage).toHaveBeenCalledWith(
      2001,
      expect.stringContaining("Registrasi Telegram Sotoayam berhasil."),
    );
  });

  it("keeps repeated /start idempotent and preserves admin-managed fields", async () => {
    const existing = makeUser({
      telegram_chat_id: 2002,
      division: "Management",
      role: "Owner",
      active: true,
      stock_alert: true,
      owner_report: true,
    });
    const repository = new ContractRepository([existing]);
    const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const accessStateResolver = { resolveByLegacyTelegramUserId: vi.fn().mockResolvedValue({
      status: "ACTIVE" as const, active: true, divisionId: 1, roleId: 1, divisionCode: "MANAGEMENT", roleCode: "OWNER",
    }) };
    const bot = new TelegramBot("contract-token", new TelegramRegistrationService(repository), accessStateResolver, sender, logger());
    const update = {
      message: { text: "/start", chat: { id: 2002 }, from: { username: "renamed", first_name: "Owner" } },
    };

    await bot.handleUpdate({ update_id: 11, ...update });
    await bot.handleUpdate({ update_id: 12, ...update });

    expect(repository.users).toHaveLength(1);
    expect(repository.registrationCalls).toHaveLength(2);
    expect(repository.users[0]).toMatchObject({
      telegram_username: "renamed",
      division: "Management",
      role: "Owner",
      active: true,
      stock_alert: true,
      owner_report: true,
    });
  });

  it("returns a sanitized fallback and never logs known credentials", async () => {
    const botToken = `${"123456"}:${"x".repeat(35)}`;
    const serverKey = `sb_secret_${"x".repeat(32)}`;
    const jwt = `${`eyJ${"x".repeat(24)}`}.${`eyJ${"y".repeat(24)}`}.${"z".repeat(32)}`;
    const repository = new ContractRepository();
    repository.upsertTelegramRegistration = vi.fn().mockRejectedValue(
      new DatabaseError("Unable to save Telegram registration", {
        code: "DB-CONN",
        message: `provider failed ${botToken} ${serverKey} ${jwt}`,
        hint: "authorization: unsafe-header-value",
      }),
    );
    const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const testLogger = logger();
    const accessStateResolver = { resolveByLegacyTelegramUserId: vi.fn() };
    const bot = new TelegramBot(botToken, new TelegramRegistrationService(repository), accessStateResolver, sender, testLogger);

    await bot.handleUpdate({
      update_id: 13,
      message: { text: "/start", chat: { id: 2003 }, from: { first_name: "Safe" } },
    });

    expect(sender.sendMessage).toHaveBeenCalledWith(
      2003,
      "Registrasi Telegram Sotoayam belum dapat diproses. Silakan coba lagi beberapa saat atau hubungi Admin Sotoayam.",
    );
    const serializedLogs = JSON.stringify(testLogger.error.mock.calls);
    expect(serializedLogs).not.toContain(botToken);
    expect(serializedLogs).not.toContain(serverKey);
    expect(serializedLogs).not.toContain(jwt);
  });
});

describe("LEGACY COMPATIBILITY CONTRACT — Admin API", () => {
  let repository: ContractRepository;
  let sender: TelegramSender;

  beforeEach(() => {
    repository = new ContractRepository([makeUser()]);
    sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
  });

  it("requires the configured Admin key and lists the legacy user shape", async () => {
    const { app } = await buildApp({ config, repository, telegramSender: sender, logger: false });
    const rejected = await app.inject({ method: "GET", url: "/api/users" });
    const accepted = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-admin-api-key": config.adminApiKey ?? "" },
    });
    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data[0]).toMatchObject({
      telegram_chat_id: 1001,
      division: "Purchasing",
      role: "Staff",
      active: false,
      stock_alert: false,
    });
    await app.close();
  });

  it("updates allowed admin fields and rejects Telegram identity changes", async () => {
    const { app } = await buildApp({ config, repository, telegramSender: sender, logger: false });
    const headers = { "x-admin-api-key": config.adminApiKey ?? "" };
    const accepted = await app.inject({
      method: "PATCH",
      url: "/api/users/1",
      headers,
      payload: { name: "Updated", division: "Gudang", role: "Admin", active: true, stock_alert: true },
    });
    const rejected = await app.inject({
      method: "PATCH",
      url: "/api/users/1",
      headers,
      payload: { telegram_chat_id: 9999 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data).toMatchObject({
      telegram_chat_id: 1001,
      name: "Updated",
      division: "Gudang",
      role: "Admin",
      active: true,
      stock_alert: true,
    });
    expect(rejected.statusCode).toBe(400);
    expect(repository.users[0]?.telegram_chat_id).toBe(1001);
    await app.close();
  });
});

describe("LEGACY COMPATIBILITY CONTRACT — internal notification API", () => {
  it("rejects missing/incorrect keys and accepts the valid internal key", async () => {
    const repository = new ContractRepository([makeUser({ active: true, stock_alert: true })]);
    const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const { app } = await buildApp({ config, repository, telegramSender: sender, logger: false });
    const payload = { type: "STOCK_CRITICAL", message: "Legacy stock contract" };

    const missing = await app.inject({ method: "POST", url: "/api/notifications/send", payload });
    const incorrect = await app.inject({
      method: "POST",
      url: "/api/notifications/send",
      headers: { "x-internal-api-key": "incorrect" },
      payload,
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/notifications/send",
      headers: { "x-internal-api-key": config.internalApiKey },
      payload,
    });

    expect(missing.statusCode).toBe(401);
    expect(incorrect.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ recipients: 1, requested: 1, sent: 1, failed: 0 });
    await app.close();
  });

  it("freezes all seven legacy type-to-boolean mappings and predicates", async () => {
    for (const [type, preference] of Object.entries(NOTIFICATION_PREFERENCE_BY_TYPE)) {
      const repository = new ContractRepository([
        makeUser({ id: 1, active: true, [preference]: true }),
        makeUser({ id: 2, telegram_chat_id: 1002, active: false, [preference]: true }),
        makeUser({ id: 3, telegram_chat_id: 1003, active: true, [preference]: false }),
      ]);
      const recipients = await new RecipientResolverService(repository).resolve(
        type as keyof typeof NOTIFICATION_PREFERENCE_BY_TYPE,
      );
      expect(repository.lastPreference).toBe(preference);
      expect(recipients.map((user) => user.id)).toEqual([1]);
    }
  });

  it("attempts every recipient when one Telegram delivery fails", async () => {
    const repository = new ContractRepository([
      makeUser({ id: 1, telegram_chat_id: 1101, active: true, system_error: true }),
      makeUser({ id: 2, telegram_chat_id: 1102, active: true, system_error: true }),
    ]);
    const sender = {
      sendMessage: vi.fn().mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce(undefined),
    };
    const result = await new NotificationService(
      new RecipientResolverService(repository),
      sender,
      logger(),
    ).send({ type: "SYSTEM_ERROR", message: "Legacy isolation contract" });

    expect(sender.sendMessage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ recipients: 2, requested: 2, sent: 1, failed: 1, success: false });
  });
});

describe("LEGACY COMPATIBILITY CONTRACT — canonical environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("loads the canonical Supabase server variables without requiring an alias", () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_contract-only");
    vi.stubEnv("SUPABASE_SERVICE_KEY", "");
    expect(loadSupabaseConfig()).toEqual({
      supabaseUrl: "https://example.supabase.co",
      supabaseServiceRoleKey: "sb_secret_contract-only",
    });
  });
});
