import { describe, expect, it, vi } from "vitest";
import type { TelegramPollingRepository, TelegramUpdateClaim } from "../../src/repositories/telegram-polling.repository.js";
import { RuntimeHealthState } from "../../src/runtime/health-state.js";
import { TelegramRegistrationService } from "../../src/services/telegram-registration.service.js";
import type { TelegramApiClient } from "../../src/services/telegram.service.js";
import { TelegramBot, type TelegramUpdate } from "../../src/telegram/bot.js";

type ApiOptions = { query?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number };

class ScriptedApi {
  readonly calls: Array<{ method: string; options: ApiOptions }> = [];
  bot?: TelegramBot;
  constructor(private readonly batches: unknown[][], private readonly getMeError?: Error) {}
  async call<T>(_token: string, method: string, options: ApiOptions = {}): Promise<T> {
    this.calls.push({ method, options });
    if (method === "getMe") {
      if (this.getMeError) throw this.getMeError;
      return { username: "test_bot" } as T;
    }
    const batch = this.batches.shift();
    if (batch) return batch as T;
    await this.bot?.stop();
    throw new DOMException("Aborted", "AbortError");
  }
}

class MemoryPollingRepository implements TelegramPollingRepository {
  readonly claims: Array<{ updateId: number; updateType: string; maxAttempts: number }> = [];
  readonly completions: Array<{ updateId: number; status: string; failureClass: string | null; retentionDays: number }> = [];
  claimResult: (updateId: number) => TelegramUpdateClaim = () => ({ action: "PROCESS", attemptCount: 1 });
  claimError?: Error;
  completeError?: Error;
  onComplete?: () => void;
  constructor(public offset = 0) {}
  async loadPollingState(): Promise<number> { return this.offset; }
  async claim(updateId: number, updateType: "message" | "callback_query" | "other", maxAttempts: number) {
    this.claims.push({ updateId, updateType, maxAttempts });
    if (this.claimError) { const error = this.claimError; this.claimError = undefined; throw error; }
    return this.claimResult(updateId);
  }
  async complete(updateId: number, status: "COMPLETED" | "FAILED", failureClass: string | null, retentionDays: number) {
    this.completions.push({ updateId, status, failureClass, retentionDays });
    if (this.completeError) { const error = this.completeError; this.completeError = undefined; throw error; }
    this.offset = Math.max(this.offset, updateId + 1);
    this.onComplete?.();
    return this.offset;
  }
}

function update(updateId: number, text = "ignored"): TelegramUpdate {
  return { update_id: updateId, message: { text, chat: { id: 1 }, from: { id: 1 } } };
}

function harness(input: { offset?: number; batches?: unknown[][]; repository?: MemoryPollingRepository;
  malformedMaxBatches?: number; sleep?: ReturnType<typeof vi.fn>; shutdownGraceMs?: number } = {}) {
  const repository = input.repository ?? new MemoryPollingRepository(input.offset ?? 0);
  const api = new ScriptedApi(input.batches ?? []);
  const runtime = new RuntimeHealthState();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  const sleep = input.sleep ?? vi.fn().mockResolvedValue(undefined);
  const bot = new TelegramBot("test-token",
    new TelegramRegistrationService({ upsertTelegramRegistration: vi.fn() }),
    { resolveByLegacyTelegramUserId: vi.fn() }, { sendMessage: vi.fn() }, logger,
    undefined, undefined, undefined, runtime, api as unknown as TelegramApiClient, repository,
    { maxAttempts: 3, retentionDays: 7, databaseBackoffMs: 1_000,
      malformedMaxBatches: input.malformedMaxBatches ?? 3 }, sleep, input.shutdownGraceMs ?? 5_000);
  api.bot = bot;
  return { bot, api, repository, runtime, logger, sleep };
}

function pollingCalls(api: ScriptedApi) { return api.calls.filter((call) => call.method === "getUpdates"); }

describe("P1-05 persisted Telegram polling", () => {
  it("P5-01 starts a fresh poll at the seeded zero offset", async () => {
    const test = harness({ offset: 0, batches: [[]] });
    await test.bot.start();
    const first = pollingCalls(test.api)[0]!;
    expect(first.options.query).toEqual({ offset: "0", timeout: "25",
      allowed_updates: JSON.stringify(["message", "callback_query"]) });
    expect(first.options.timeoutMs).toBe(30_000);
    expect(first.options.signal).toBeInstanceOf(AbortSignal);
  });

  it("P5-02 resumes the first poll from the stored offset", async () => {
    const test = harness({ offset: 4711, batches: [[]] });
    await test.bot.start();
    expect(pollingCalls(test.api)[0]?.options.query?.offset).toBe("4711");
  });

  it("P5-03 fails closed when persisted state cannot be loaded", async () => {
    const repository = new MemoryPollingRepository();
    vi.spyOn(repository, "loadPollingState").mockRejectedValue(new Error("database unavailable"));
    const test = harness({ repository });
    await expect(test.bot.start()).rejects.toThrow("database unavailable");
    expect(pollingCalls(test.api)).toHaveLength(0);
    expect(test.runtime.telegramPollingActive).toBe(false);
  });

  it("P5-04 skips a terminal duplicate but still completes it to advance", async () => {
    const repository = new MemoryPollingRepository();
    repository.claimResult = () => ({ action: "SKIP_DUPLICATE", attemptCount: 1 });
    const test = harness({ repository, batches: [[update(10)]] });
    const handler = vi.spyOn(test.bot, "handleUpdate");
    await test.bot.start();
    expect(handler).not.toHaveBeenCalled();
    expect(repository.completions).toEqual([{ updateId: 10, status: "COMPLETED", failureClass: null, retentionDays: 7 }]);
  });

  it("P5-05 claims, handles, then atomically completes before changing the next poll offset", async () => {
    const order: string[] = []; const repository = new MemoryPollingRepository();
    vi.spyOn(repository, "claim").mockImplementation(async (...args) => {
      order.push("claim"); return MemoryPollingRepository.prototype.claim.apply(repository, args);
    });
    vi.spyOn(repository, "complete").mockImplementation(async (...args) => {
      order.push("complete"); return MemoryPollingRepository.prototype.complete.apply(repository, args);
    });
    const test = harness({ repository, batches: [[update(12)]] });
    vi.spyOn(test.bot, "handleUpdate").mockImplementation(async () => { order.push("handler"); });
    await test.bot.start();
    expect(order).toEqual(["claim", "handler", "complete"]);
    expect(pollingCalls(test.api).map((call) => call.options.query?.offset)).toEqual(["0", "13"]);
  });

  it("P5-06 performs no claim or completion writes for an empty poll", async () => {
    const test = harness({ offset: 88, batches: [[]] });
    await test.bot.start();
    expect(test.repository.claims).toHaveLength(0);
    expect(test.repository.completions).toHaveLength(0);
    expect(pollingCalls(test.api).map((call) => call.options.query?.offset)).toEqual(["88", "88"]);
  });

  it("P5-07 records handler failure terminally and continues to the next update", async () => {
    const test = harness({ batches: [[update(20), update(21)]] });
    vi.spyOn(test.bot, "handleUpdate").mockImplementation(async (item) => {
      if (item.update_id === 20) throw new Error("handler failure");
    });
    await test.bot.start();
    expect(test.repository.completions).toEqual([
      { updateId: 20, status: "FAILED", failureClass: "HANDLER_ERROR", retentionDays: 7 },
      { updateId: 21, status: "COMPLETED", failureClass: null, retentionDays: 7 },
    ]);
  });

  it("P5-08 completes an exhausted poison update without invoking the handler", async () => {
    const repository = new MemoryPollingRepository();
    repository.claimResult = () => ({ action: "SKIP_EXHAUSTED", attemptCount: 4 });
    const test = harness({ repository, batches: [[update(30)]] });
    const handler = vi.spyOn(test.bot, "handleUpdate");
    await test.bot.start();
    expect(handler).not.toHaveBeenCalled();
    expect(repository.completions[0]).toMatchObject({ updateId: 30, status: "FAILED", failureClass: "ATTEMPTS_EXHAUSTED" });
  });

  it("P5-09 abandons a batch on database failure and re-polls the unchanged offset", async () => {
    const repository = new MemoryPollingRepository(); repository.claimError = new Error("database unavailable");
    const test = harness({ repository, batches: [[update(40)], [update(40)]] });
    const handler = vi.spyOn(test.bot, "handleUpdate").mockResolvedValue(undefined);
    await test.bot.start();
    expect(pollingCalls(test.api).slice(0, 2).map((call) => call.options.query?.offset)).toEqual(["0", "0"]);
    expect(handler).toHaveBeenCalledOnce();
    expect(test.sleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
  });

  it("P5-10 rejects a malformed batch wholly with no claims or completions", async () => {
    const test = harness({ batches: [[[update(50), { message: { text: "bad" } }]].flat()], malformedMaxBatches: 1 });
    await test.bot.start();
    expect(test.repository.claims).toHaveLength(0);
    expect(test.repository.completions).toHaveLength(0);
    expect(pollingCalls(test.api)[0]?.options.query?.offset).toBe("0");
  });

  it("P5-22 retries malformed batches at the same offset then halts loudly", async () => {
    const malformed = [{ update_id: "invalid", message: { text: "hidden" } }];
    const test = harness({ offset: 70, batches: [malformed, malformed, malformed], malformedMaxBatches: 3 });
    await test.bot.start();
    expect(pollingCalls(test.api).map((call) => call.options.query?.offset)).toEqual(["70", "70", "70"]);
    expect(test.repository.claims).toHaveLength(0);
    expect(test.repository.completions).toHaveLength(0);
    expect(test.runtime.telegramPollingActive).toBe(false);
    expect(test.logger.fatal).toHaveBeenCalledOnce();
  });

  it("P5-23 logs only a malformed entry structural fingerprint", async () => {
    const secretText = "customer-message-must-not-appear";
    const malformed = [{ update_id: "bad-id", message: { text: secretText }, token: "test-token" }];
    const test = harness({ batches: [malformed], malformedMaxBatches: 1 });
    await test.bot.start();
    const serialized = JSON.stringify([...test.logger.error.mock.calls, ...test.logger.fatal.mock.calls]);
    expect(serialized).toContain("message,token,update_id");
    expect(serialized).not.toContain(secretText);
    expect(serialized).not.toContain("bad-id");
    expect(serialized).not.toContain("test-token");
  });

  it("P5-24 sorts [102,101] ascending and collapses repeated ids", async () => {
    const test = harness({ batches: [[update(102), update(101), update(101)]] });
    const handled: number[] = [];
    vi.spyOn(test.bot, "handleUpdate").mockImplementation(async (item) => { handled.push(item.update_id); });
    await test.bot.start();
    expect(test.repository.claims.map((claim) => claim.updateId)).toEqual([101, 102]);
    expect(handled).toEqual([101, 102]);
  });

  it("P5-25 keeps 102 redeliverable when [102,101] crashes before completing 102", async () => {
    const repository = new MemoryPollingRepository(101);
    const realComplete = repository.complete.bind(repository);
    vi.spyOn(repository, "complete").mockImplementation(async (updateId, status, failureClass, retentionDays) => {
      if (updateId === 102) throw new Error("simulated completion crash");
      return realComplete(updateId, status, failureClass, retentionDays);
    });
    const test = harness({ repository, batches: [[update(102), update(101)], []] });
    const handled: number[] = [];
    vi.spyOn(test.bot, "handleUpdate").mockImplementation(async (item) => { handled.push(item.update_id); });
    await test.bot.start();
    expect(handled).toEqual([101, 102]);
    expect(pollingCalls(test.api).slice(0, 2).map((call) => call.options.query?.offset)).toEqual(["101", "102"]);
    expect(repository.claims.map((claim) => claim.updateId)).toEqual([101, 102]);
  });

  it("P5-11 completes an in-flight update during graceful shutdown", async () => {
    let release!: () => void; const entered = new Promise<void>((resolve) => { release = resolve; });
    let handlerStarted!: () => void; const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    const test = harness({ batches: [[update(90)]] });
    vi.spyOn(test.bot, "handleUpdate").mockImplementation(async () => { handlerStarted(); await entered; });
    const running = test.bot.start();
    await started;
    const stopping = test.bot.stop();
    release();
    await stopping;
    await running;
    expect(test.repository.completions).toEqual([
      { updateId: 90, status: "COMPLETED", failureClass: null, retentionDays: 7 },
    ]);
  });

  it("leaves an over-grace in-flight update PROCESSING for restart recovery", async () => {
    let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
    let handlerStarted!: () => void; const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    const test = harness({ batches: [[update(91)]], shutdownGraceMs: 1 });
    vi.spyOn(test.bot, "handleUpdate").mockImplementation(async () => { handlerStarted(); await blocked; });
    const running = test.bot.start(); await started;
    await test.bot.stop();
    release(); await running;
    expect(test.repository.claims.map((claim) => claim.updateId)).toEqual([91]);
    expect(test.repository.completions).toHaveLength(0);
  });
});
