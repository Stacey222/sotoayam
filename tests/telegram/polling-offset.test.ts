import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramBot } from "../../src/telegram/bot.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const response = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });

describe("Telegram polling acknowledgement", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries a failed update before advancing the polling offset", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ username: "gwens" }))
      .mockResolvedValueOnce(response([{ update_id: 10, message: { chat: { id: 1 } } }, { update_id: 11, message: { chat: { id: 1 } } }]))
      .mockResolvedValueOnce(response([{ update_id: 10, message: { chat: { id: 1 } } }, { update_id: 11, message: { chat: { id: 1 } } }]));
    vi.stubGlobal("fetch", fetchMock);
    const bot = new TelegramBot("test-token", {} as never, {} as never, {} as never, logger, undefined, undefined, undefined, undefined, async () => undefined);
    let attempts = 0;
    vi.spyOn(bot, "handleUpdate").mockImplementation(async (update) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
      if (update.update_id === 11) bot.stop();
    });

    await bot.start();

    expect(bot.handleUpdate).toHaveBeenCalledWith(expect.objectContaining({ update_id: 10 }));
    expect(bot.handleUpdate).toHaveBeenCalledTimes(3);
    const pollUrls = fetchMock.mock.calls.slice(1).map(([url]) => String(url));
    expect(pollUrls).toHaveLength(2);
    expect(pollUrls.every((url) => url.includes("offset=0"))).toBe(true);
  });
});
