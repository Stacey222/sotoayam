import { describe, expect, it, vi } from "vitest";
import { OutboundHttpClient } from "../../src/http/outbound-http-client.js";
import { TelegramFanoutService } from "../../src/services/telegram-fanout.service.js";
import { TelegramApiClient, TelegramService } from "../../src/services/telegram.service.js";

function requests(count: number) {
  return Array.from({ length: count }, (_, index) => ({ chatId: index + 1, message: `message-${index + 1}` }));
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(predicate()).toBe(true);
}

describe("P1-06 bounded Telegram fan-out", () => {
  it("uses the conservative default concurrency bound of three", async () => {
    const releases: Array<() => void> = [];
    const sender = { sendMessage: vi.fn(() => new Promise<void>((resolve) => releases.push(resolve))) };
    const fanout = new TelegramFanoutService(sender, undefined, () => 0, async () => undefined);
    const operation = fanout.sendAll(requests(4));

    await until(() => sender.sendMessage.mock.calls.length === 3);
    expect(sender.sendMessage).toHaveBeenCalledTimes(3);
    releases.splice(0).forEach((release) => release());
    await until(() => sender.sendMessage.mock.calls.length === 4);
    releases.splice(0).forEach((release) => release());
    await operation;
  });

  it("never exceeds the configured concurrency bound", async () => {
    let active = 0; let maximum = 0;
    const releases: Array<() => void> = [];
    const sender = { sendMessage: vi.fn(async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    }) };
    const fanout = new TelegramFanoutService(sender, { concurrency: 3, intervalMs: 0 });
    const operation = fanout.sendAll(requests(25));

    while (sender.sendMessage.mock.calls.length < 25) {
      await until(() => releases.length > 0);
      releases.splice(0).forEach((release) => release());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    releases.splice(0).forEach((release) => release());
    await operation;

    expect(maximum).toBe(3);
    expect(sender.sendMessage).toHaveBeenCalledTimes(25);
  });

  it("processes a large recipient set through bounded worker slots", async () => {
    let active = 0; let maximum = 0;
    const sender = { sendMessage: vi.fn(async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
    }) };
    const fanout = new TelegramFanoutService(sender, { concurrency: 2, intervalMs: 0 });

    const outcomes = await fanout.sendAll(requests(1_000));

    expect(outcomes).toHaveLength(1_000);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(sender.sendMessage).toHaveBeenCalledTimes(1_000);
  });

  it("paces request starts by the configured minimum interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const starts: number[] = [];
      const sender = { sendMessage: vi.fn(async () => { starts.push(Date.now()); }) };
      const fanout = new TelegramFanoutService(sender, { concurrency: 3, intervalMs: 100 });
      const operation = fanout.sendAll(requests(5));

      await vi.advanceTimersByTimeAsync(99);
      expect(starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(301);
      await operation;

      expect(starts).toEqual([0, 100, 200, 300, 400]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bunch paced starts after an event-loop clock jump", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const starts: number[] = [];
      const sender = { sendMessage: vi.fn(async () => { starts.push(Date.now()); }) };
      const fanout = new TelegramFanoutService(sender, { concurrency: 3, intervalMs: 100 });
      const operation = fanout.sendAll(requests(3));
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual([0]);

      vi.setSystemTime(1_000);
      await vi.runOnlyPendingTimersAsync();
      await vi.runOnlyPendingTimersAsync();
      await operation;

      expect(starts[0]).toBe(0);
      expect(starts[1]).toBeGreaterThanOrEqual(1_000);
      expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates one recipient failure and preserves input-order accounting", async () => {
    const sender = { sendMessage: vi.fn(async (chatId: number) => {
      if (chatId === 2) throw new Error("recipient failed");
    }) };
    const fanout = new TelegramFanoutService(sender, { concurrency: 2, intervalMs: 0 });

    const outcomes = await fanout.sendAll(requests(4));

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect(sender.sendMessage.mock.calls.map(([chatId]) => chatId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("starts each recipient send exactly once", async () => {
    const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const fanout = new TelegramFanoutService(sender, { concurrency: 3, intervalMs: 0 });

    await fanout.sendAll(requests(40));

    const calls = sender.sendMessage.mock.calls.map(([chatId]) => chatId);
    expect(calls).toHaveLength(40);
    expect(new Set(calls).size).toBe(40);
  });

  it("stops assigning new sends after shutdown and aborts pending slots", async () => {
    let releaseFirst!: () => void;
    const sender = { sendMessage: vi.fn(() => new Promise<void>((resolve) => { releaseFirst = resolve; })) };
    const fanout = new TelegramFanoutService(sender, { concurrency: 1, intervalMs: 0 });
    const operation = fanout.sendAll(requests(100));
    await until(() => sender.sendMessage.mock.calls.length === 1);

    fanout.stop();
    releaseFirst();
    const outcomes = await operation;

    expect(sender.sendMessage).toHaveBeenCalledOnce();
    expect(outcomes).toHaveLength(100);
    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes.slice(1).every((outcome) => outcome.status === "rejected")).toBe(true);
  });

  it("aborts a pending pacing wait immediately without starting that send", async () => {
    const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const fanout = new TelegramFanoutService(sender, { concurrency: 2, intervalMs: 60_000 });
    const operation = fanout.sendAll(requests(2));
    await until(() => sender.sendMessage.mock.calls.length === 1);

    fanout.stop();
    const outcomes = await operation;

    expect(sender.sendMessage).toHaveBeenCalledOnce();
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
  });

  it("keeps empty and single-recipient behavior compatible", async () => {
    const sender = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const fanout = new TelegramFanoutService(sender, { concurrency: 3, intervalMs: 0 });

    expect(await fanout.sendAll([])).toEqual([]);
    expect(await fanout.sendAll(requests(1))).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(sender.sendMessage).toHaveBeenCalledWith(1, "message-1");
  });

  it("leaves Telegram 429 retry handling in the P1-02 outbound client", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error_code: 429,
        parameters: { retry_after: 2 } }), { status: 429, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } }));
    const retrySleep = vi.fn().mockResolvedValue(undefined);
    const telegram = new TelegramService("test-token", undefined,
      new TelegramApiClient(new OutboundHttpClient({ fetch, sleep: retrySleep, maxRetries: 2 })));
    const fanout = new TelegramFanoutService(telegram, { concurrency: 1, intervalMs: 0 });

    const outcomes = await fanout.sendAll([{ chatId: 1, message: "hello" }]);

    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(retrySleep).toHaveBeenCalledWith(2_000, undefined);
  });
});
