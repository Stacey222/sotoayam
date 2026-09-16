import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { NotificationPreferenceShadowRepository } from "../../src/repositories/notification-preferences.repository.js";
import type { TelegramUsersRepository } from "../../src/repositories/telegram-users.repository.js";
import { NotificationService } from "../../src/services/notification.service.js";
import { RecipientResolverService } from "../../src/services/recipient-resolver.service.js";
import type { TelegramSender } from "../../src/services/telegram.service.js";
import { NOTIFICATION_PREFERENCE_BY_TYPE, type NotificationType, type TelegramUser } from "../../src/types/index.js";

const recipient: TelegramUser = { id: 17, telegram_chat_id: 999001, telegram_username: null,
  telegram_first_name: null, name: "Fixture", division: "IT", role: "Staff", active: true,
  stock_alert: true, purchase_alert: true, sales_alert: true, marketing_alert: true,
  content_alert: true, owner_report: true, system_error: true,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };

function fixture(shadowResult: TelegramUser[] | Error, mode: "LEGACY" | "COMPARE" | "NORMALIZED" = "COMPARE") {
  const users = { findRecipientsForNotification: vi.fn(async () => [recipient]) } as unknown as TelegramUsersRepository;
  const shadow: NotificationPreferenceShadowRepository = { findNormalizedRecipients: vi.fn(async () => {
    if (shadowResult instanceof Error) throw shadowResult;
    return shadowResult;
  }) };
  const log = { info: vi.fn((_fields: Record<string, unknown>, _message: string) => undefined),
    warn: vi.fn((_fields: Record<string, unknown>, _message: string) => undefined) };
  const resolver = new RecipientResolverService(users, shadow, log, mode);
  return { resolver, log, users, shadow };
}

describe("P2-03 legacy-authoritative shadow comparison", () => {
  it("compares all seven type mappings without changing selected recipients", async () => {
    const { resolver, log, users } = fixture([recipient]);
    for (const type of Object.keys(NOTIFICATION_PREFERENCE_BY_TYPE) as NotificationType[]) {
      expect(await resolver.resolve(type)).toEqual([recipient]);
    }
    expect(users.findRecipientsForNotification).toHaveBeenCalledTimes(7);
    expect(log.info).toHaveBeenCalledTimes(7);
    for (const [fields] of log.info.mock.calls) {
      expect(fields).toMatchObject({ legacy_recipient_count: 1, normalized_recipient_count: 1,
        mismatch_count: 0, parity: true });
      expect(JSON.stringify(fields)).not.toMatch(/999001|Fixture|telegram_chat_id|user_id/);
    }
  });

  it("reports bidirectional mismatches but still sends exactly once to the legacy recipient", async () => {
    const extra = { ...recipient, id: 18, telegram_chat_id: 999002 };
    const { resolver, log } = fixture([extra]);
    const sendMessage = vi.fn(async (_chatId: number, _message: string) => undefined);
    const service = new NotificationService(resolver, { sendMessage } as unknown as TelegramSender,
      log as unknown as Pick<FastifyBaseLogger, "info" | "warn">);
    const result = await service.send({ type: "STOCK_CRITICAL", message: "Operational fixture" });
    expect(result).toMatchObject({ recipients: 1, requested: 1, sent: 1, failed: 0 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(recipient.telegram_chat_id);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ legacy_recipient_count: 1,
      normalized_recipient_count: 1, mismatch_count: 2, parity: false }), "Notification preference recipient mismatch");
  });

  it("keeps legacy delivery available when the read-only comparison fails", async () => {
    const { resolver, log } = fixture(new Error("private database detail"));
    expect(await resolver.resolve("SYSTEM_ERROR")).toEqual([recipient]);
    expect(log.warn).toHaveBeenCalledWith({ notification_type: "SYSTEM_ERROR", parity: false },
      "Notification preference comparison unavailable");
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("private database detail");
  });

  it("returns normalized recipients exclusively when in NORMALIZED mode", async () => {
    const normalizedRecipient = { ...recipient, id: 99, telegram_chat_id: 111222 };
    const { resolver, users } = fixture([normalizedRecipient], "NORMALIZED");
    const result = await resolver.resolve("SYSTEM_ERROR");
    expect(result).toEqual([normalizedRecipient]);
    expect(users.findRecipientsForNotification).not.toHaveBeenCalled();
  });
});
