import { describe, expect, it, vi } from "vitest";
import { OutboundHttpClient } from "../../src/http/outbound-http-client.js";
import { NotificationService } from "../../src/services/notification.service.js";
import { TelegramRegistrationService } from "../../src/services/telegram-registration.service.js";
import {
  TelegramApiClient,
  TelegramOperationError,
  TelegramService,
} from "../../src/services/telegram.service.js";
import { TelegramBot } from "../../src/telegram/bot.js";

function telegramResponse(status: number, body: Record<string, unknown>, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function service(fetch: ReturnType<typeof vi.fn>, sleep = vi.fn().mockResolvedValue(undefined)) {
  const http = new OutboundHttpClient({ fetch, sleep, maxRetries: 2 });
  return { telegram: new TelegramService("test-bot-token", undefined, new TelegramApiClient(http)), sleep };
}

describe("Telegram outbound HTTP behavior", () => {
  it.each([
    ["Retry-After header", { "retry-after": "2" }, {}, 2_000],
    ["Telegram retry_after body", {}, { parameters: { retry_after: 3 } }, 3_000],
  ])("honors %s on HTTP 429 before a bounded retry", async (_label, headers, extraBody, expectedDelay) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(telegramResponse(429, { ok: false, error_code: 429, ...extraBody }, headers))
      .mockResolvedValueOnce(telegramResponse(200, { ok: true, result: { message_id: 1 } }));
    const test = service(fetch);

    await test.telegram.sendMessage(42, "hello");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(test.sleep).toHaveBeenCalledOnce();
    expect(test.sleep).toHaveBeenCalledWith(expectedDelay, undefined);
  });

  it("uses the longer valid delay when Telegram body and HTTP header conflict", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(telegramResponse(429, { ok: false, error_code: 429,
        parameters: { retry_after: 2 } }, { "retry-after": "5" }))
      .mockResolvedValueOnce(telegramResponse(200, { ok: true, result: { message_id: 1 } }));
    const test = service(fetch);

    await test.telegram.sendMessage(42, "hello");

    expect(test.sleep).toHaveBeenCalledWith(5_000, undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces a Telegram retry_after above the local cap without retrying early", async () => {
    const fetch = vi.fn().mockResolvedValue(telegramResponse(429, { ok: false, error_code: 429,
      parameters: { retry_after: 61 } }));
    const test = service(fetch);

    const error = await test.telegram.sendMessage(42, "hello").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TelegramOperationError);
    expect(error).toMatchObject({ code: "TELEGRAM_SEND_FAILED", classification: {
      transportKind: "HTTP", httpStatus: 429, attempts: 1, retryable: true,
      retryExhausted: false, retryAfterMs: 61_000,
    } });
    expect(test.sleep).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("exits TelegramBot.start after exactly three exhausted polling attempts", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(telegramResponse(200, { ok: true, result: { username: "test_bot" } }))
      .mockResolvedValue(telegramResponse(503, { ok: false, error_code: 503 }));
    const http = new OutboundHttpClient({ fetch, sleep: async () => undefined, maxRetries: 2 });
    const api = new TelegramApiClient(http);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const bot = new TelegramBot("test-bot-token",
      new TelegramRegistrationService({ upsertTelegramRegistration: vi.fn() }),
      { resolveByLegacyTelegramUserId: vi.fn() }, { sendMessage: vi.fn() }, logger,
      undefined, undefined, undefined, undefined, api);

    await expect(bot.start()).rejects.toMatchObject({ attempts: 3, retryExhausted: true, httpStatus: 503 });

    const pollingCalls = fetch.mock.calls.filter(([input]) => String(input).includes("/getUpdates"));
    expect(pollingCalls).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry an unsafe Telegram POST on 5xx and preserves the caller contract", async () => {
    const fetch = vi.fn().mockResolvedValue(telegramResponse(503, { ok: false, error_code: 503 }));
    const test = service(fetch);

    const error = await test.telegram.sendMessage(42, "hello").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TelegramOperationError);
    expect(error).toMatchObject({ statusCode: 502, code: "TELEGRAM_SEND_FAILED",
      message: "Telegram rejected sendMessage request",
      classification: { transportKind: "HTTP", httpStatus: 503, attempts: 1, retryable: false } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps notification batch failure accounting compatible", async () => {
    const fetch = vi.fn().mockResolvedValue(telegramResponse(400, { ok: false, error_code: 400 }));
    const test = service(fetch);
    const resolver = { resolve: vi.fn().mockResolvedValue([{ telegram_chat_id: 42 }]) };
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await new NotificationService(resolver as never, test.telegram, logger)
      .send({ type: "SYSTEM_ERROR", message: "unavailable" });

    expect(result).toMatchObject({ success: false, recipients: 1, requested: 1, sent: 0, failed: 1 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
