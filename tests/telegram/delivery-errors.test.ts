import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramDeliveryError, TelegramService } from "../../src/services/telegram.service.js";

describe("Telegram delivery errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("classifies provider rate limits and preserves retry_after", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ parameters: { retry_after: 17 } }), { status: 429 })));
    await expect(new TelegramService("test-token").sendMessage(1, "hello")).rejects.toMatchObject({ code: "TELEGRAM_RATE_LIMITED", retryAfterSeconds: 17 });
  });

  it("classifies permanent provider rejection separately from transient failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));
    await expect(new TelegramService("test-token").sendMessage(1, "hello")).rejects.toBeInstanceOf(TelegramDeliveryError);
    await expect(new TelegramService("test-token").sendMessage(1, "hello")).rejects.toMatchObject({ code: "TELEGRAM_SEND_PERMANENT" });
  });
});
