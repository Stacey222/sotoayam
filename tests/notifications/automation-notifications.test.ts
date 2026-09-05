import { describe, expect, it, vi } from "vitest";
import type { TelegramUser } from "../../src/types/index.js";
import type { RecipientResolverService } from "../../src/services/recipient-resolver.service.js";
import { NotificationService } from "../../src/services/notification.service.js";
import type { TelegramSender } from "../../src/services/telegram.service.js";
import type { AutomationDelivery, AutomationNotificationRepository } from "../../src/repositories/automation-notifications.repository.js";

const recipients: TelegramUser[] = [
  { id: 1, telegram_chat_id: 101, telegram_username: null, telegram_first_name: null, name: "A", division: "IT", role: "Admin", active: true, stock_alert: false, purchase_alert: false, sales_alert: false, marketing_alert: false, content_alert: false, owner_report: false, system_error: true, created_at: "now", updated_at: "now" },
  { id: 2, telegram_chat_id: 102, telegram_username: null, telegram_first_name: null, name: "B", division: "IT", role: "Admin", active: true, stock_alert: false, purchase_alert: false, sales_alert: false, marketing_alert: false, content_alert: false, owner_report: false, system_error: true, created_at: "now", updated_at: "now" },
];

class Deliveries implements AutomationNotificationRepository {
  event?: { id: number; key?: string; type: string; message: string };
  rows: AutomationDelivery[] = [];
  async createOrGet(input: { eventId: string | undefined; type: string; message: string; recipients: TelegramUser[] }) {
    if (this.event) {
      if (this.event.key === input.eventId && (this.event.type !== input.type || this.event.message !== input.message)) throw new Error("conflict");
      return { eventId: this.event.id, created: false };
    }
    this.event = { id: 1, key: input.eventId, type: input.type, message: input.message };
    this.rows = input.recipients.map((recipient, index) => ({ id: index + 1, event_id: 1, recipient_telegram_user_id: recipient.id,
      telegram_chat_id: recipient.telegram_chat_id, state: "PENDING", attempt_count: 0, max_attempts: 3, next_attempt_at: "1970-01-01T00:00:00.000Z", updated_at: "1970-01-01T00:00:00.000Z" }));
    return { eventId: 1, created: true };
  }
  async findDue(_eventId: number, now: string) { return this.rows.filter((row) => row.state === "PENDING" && row.next_attempt_at! <= now); }
  async claim(delivery: AutomationDelivery) { const row = this.rows.find((item) => item.id === delivery.id && item.state === "PENDING"); if (!row) return null; row.state = "PROCESSING"; return { ...row }; }
  async markDelivered(id: number, attempts: number) { const row = this.rows.find((item) => item.id === id)!; row.state = "DELIVERED"; row.attempt_count = attempts; row.next_attempt_at = null; }
  async markFailed(id: number, input: { state: "PENDING" | "FAILED"; attemptCount: number; nextAttemptAt: string | null }) { const row = this.rows.find((item) => item.id === id)!; row.state = input.state; row.attempt_count = input.attemptCount; row.next_attempt_at = input.nextAttemptAt; }
  async status() { const pending = this.rows.filter((item) => item.state === "PENDING" || item.state === "PROCESSING"); return { requested: this.rows.length, sent: this.rows.filter((item) => item.state === "DELIVERED").length, pending: pending.length, failed: this.rows.filter((item) => item.state === "FAILED").length, retryAt: pending.map((item) => item.next_attempt_at).filter((value): value is string => Boolean(value)).sort()[0] ?? null }; }
}

describe("durable automation notification delivery", () => {
  it("deduplicates a stable event ID and retries only the failed recipient", async () => {
    let now = new Date(0);
    const store = new Deliveries();
    const sender: TelegramSender = { sendMessage: vi.fn().mockImplementation(async (chatId) => { if (chatId === 102 && now.getTime() === 0) throw Object.assign(new Error("temporary"), { code: "TELEGRAM_SEND_FAILED" }); }) };
    const service = new NotificationService({ resolve: async () => recipients } as unknown as RecipientResolverService, sender, { info: vi.fn(), warn: vi.fn() }, store, () => now);
    const first = await service.send({ event_id: "n8n-42", type: "SYSTEM_ERROR", message: "Service unavailable" });
    expect(first).toMatchObject({ success: false, sent: 1, pending: 1, deduplicated: false, retryAfterSeconds: 300 });
    now = new Date(300_000);
    const retry = await service.send({ event_id: "n8n-42", type: "SYSTEM_ERROR", message: "Service unavailable" });
    expect(retry).toMatchObject({ success: true, sent: 2, pending: 0, deduplicated: true });
    expect(sender.sendMessage).toHaveBeenCalledTimes(3);
    expect(sender.sendMessage).toHaveBeenLastCalledWith(102, "Service unavailable");
  });
});
