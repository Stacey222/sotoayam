import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/env.js";
import { DatabaseError } from "../src/errors.js";
import type { TelegramUsersRepository } from "../src/repositories/telegram-users.repository.js";
import { NotificationService } from "../src/services/notification.service.js";
import { RecipientResolverService } from "../src/services/recipient-resolver.service.js";
import type { TelegramSender } from "../src/services/telegram.service.js";
import { TelegramRegistrationService } from "../src/services/telegram-registration.service.js";
import { TelegramBot } from "../src/telegram/bot.js";
import type {
  NotificationPreference,
  TelegramRegistration,
  TelegramUser,
  UserFilters,
  UserUpdate,
} from "../src/types/index.js";

const config: AppConfig = {
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "test-service-key",
  telegramBotToken: "test-bot-token",
  internalApiKey: "test-internal-key",
  adminApiKey: undefined,
  port: 3000,
  telegramPollingEnabled: false,
  logLevel: "silent",
};

function user(overrides: Partial<TelegramUser> = {}): TelegramUser {
  return {
    id: 1,
    telegram_chat_id: 1001,
    telegram_username: "andi",
    telegram_first_name: "Andi",
    name: "Andi",
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

class MemoryRepository implements TelegramUsersRepository {
  users: TelegramUser[];
  lastPreference?: NotificationPreference;

  constructor(users: TelegramUser[] = []) {
    this.users = users;
  }

  async findAll(_filters?: UserFilters): Promise<TelegramUser[]> { return this.users; }
  async findById(id: number): Promise<TelegramUser | null> { return this.users.find((item) => item.id === id) ?? null; }
  async findByTelegramChatId(chatId: number): Promise<TelegramUser | null> {
    return this.users.find((item) => item.telegram_chat_id === chatId) ?? null;
  }
  async upsertTelegramRegistration(registration: TelegramRegistration): Promise<TelegramUser> {
    const existing = await this.findByTelegramChatId(registration.telegram_chat_id);
    if (existing) {
      existing.telegram_username = registration.telegram_username;
      existing.telegram_first_name = registration.telegram_first_name;
      return existing;
    }
    const created = user({
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
    return this.users.filter((item) => item.active && item[preference]);
  }
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("HTTP API", () => {
  let repository: MemoryRepository;
  let sender: TelegramSender;

  beforeEach(() => {
    repository = new MemoryRepository();
    sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
  });

  it("returns health status", async () => {
    const { app } = await buildApp({ config, repository, telegramSender: sender, logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("rejects an unknown notification type", async () => {
    const { app } = await buildApp({ config, repository, telegramSender: sender, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/notifications/send",
      headers: { "x-internal-api-key": config.internalApiKey },
      payload: { type: "UNKNOWN", message: "test" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("rejects an empty message", async () => {
    const { app } = await buildApp({ config, repository, telegramSender: sender, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/notifications/send",
      headers: { "x-internal-api-key": config.internalApiKey },
      payload: { type: "STOCK_CRITICAL", message: "   " },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("empty");
    await app.close();
  });
});

describe("recipient routing", () => {
  it("maps every event to its preference", async () => {
    const repository = new MemoryRepository();
    const resolver = new RecipientResolverService(repository);
    const cases = {
      STOCK_CRITICAL: "stock_alert",
      PURCHASE_RECOMMENDATION: "purchase_alert",
      SALES_FOLLOWUP: "sales_alert",
      MARKETING_ALERT: "marketing_alert",
      CONTENT_OPPORTUNITY: "content_alert",
      OWNER_DAILY_REPORT: "owner_report",
      SYSTEM_ERROR: "system_error",
    } as const;
    for (const [type, preference] of Object.entries(cases)) {
      await resolver.resolve(type as keyof typeof cases);
      expect(repository.lastPreference).toBe(preference);
    }
  });

  it("excludes inactive users", async () => {
    const repository = new MemoryRepository([user({ active: false, stock_alert: true })]);
    expect(await new RecipientResolverService(repository).resolve("STOCK_CRITICAL")).toHaveLength(0);
  });

  it("excludes users with a disabled preference", async () => {
    const repository = new MemoryRepository([user({ active: true, stock_alert: false })]);
    expect(await new RecipientResolverService(repository).resolve("STOCK_CRITICAL")).toHaveLength(0);
  });

  it("includes active users with an enabled preference", async () => {
    const repository = new MemoryRepository([user({ active: true, stock_alert: true })]);
    expect(await new RecipientResolverService(repository).resolve("STOCK_CRITICAL")).toHaveLength(1);
  });
});

describe("Telegram behavior", () => {
  it("does not reset admin configuration on repeated /start", async () => {
    const configured = user({ division: "Management", role: "Owner", active: true, owner_report: true });
    const repository = new MemoryRepository([configured]);
    const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const accessStateResolver = { resolveByLegacyTelegramUserId: vi.fn().mockResolvedValue({
      status: "ACTIVE" as const, active: true, divisionId: 1, roleId: 1,
      divisionCode: "MANAGEMENT", roleCode: "OWNER",
    }) };
    const bot = new TelegramBot("token", new TelegramRegistrationService(repository), accessStateResolver, sender, silentLogger);
    await bot.handleUpdate({ update_id: 1, message: { text: "/start", chat: { id: 1001 }, from: { username: "andi_baru", first_name: "Andi" } } });
    await bot.handleUpdate({ update_id: 2, message: { text: "/start", chat: { id: 1001 }, from: { username: "andi_baru", first_name: "Andi" } } });
    expect(repository.users).toHaveLength(1);
    expect(repository.users[0]).toMatchObject({ division: "Management", role: "Owner", active: true, owner_report: true });
  });

  it("sends a generic reply when Telegram registration storage fails", async () => {
    silentLogger.error.mockClear();
    const repository = new MemoryRepository();
    repository.upsertTelegramRegistration = vi.fn().mockRejectedValue(
      new DatabaseError("Unable to save Telegram registration", {
        code: "42501",
        message: "new row violates row-level security policy",
      }),
    );
    const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const accessStateResolver = { resolveByLegacyTelegramUserId: vi.fn() };
    const bot = new TelegramBot("token", new TelegramRegistrationService(repository), accessStateResolver, sender, silentLogger);

    await bot.handleUpdate({
      update_id: 3,
      message: { text: "/start", chat: { id: 1003 }, from: { first_name: "Sari" } },
    });

    expect(sender.sendMessage).toHaveBeenCalledWith(
      1003,
      "Registrasi Telegram Gwens belum dapat diproses. Silakan coba lagi beberapa saat atau hubungi Admin Gwens.",
    );
    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "42501", errorMessage: "new row violates row-level security policy" }),
      "Telegram registration failed",
    );
  });

  it("isolates one recipient failure from the rest of the batch", async () => {
    const repository = new MemoryRepository([
      user({ id: 1, telegram_chat_id: 101, active: true, system_error: true }),
      user({ id: 2, telegram_chat_id: 102, active: true, system_error: true }),
    ]);
    const sender: TelegramSender = {
      sendMessage: vi.fn().mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce(undefined),
    };
    const service = new NotificationService(new RecipientResolverService(repository), sender, silentLogger);
    const result = await service.send({ type: "SYSTEM_ERROR", message: "Service unavailable" });
    expect(result).toMatchObject({ recipients: 2, requested: 2, sent: 1, failed: 1, success: false });
    expect(sender.sendMessage).toHaveBeenCalledTimes(2);
  });
});
