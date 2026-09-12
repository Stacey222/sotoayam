import type { TelegramMessageOptions, TelegramSender } from "./telegram.service.js";

export interface TelegramFanoutPolicy {
  concurrency: number;
  intervalMs: number;
}

export interface TelegramFanoutRequest {
  chatId: number;
  message: string;
  options?: TelegramMessageOptions;
}

const DEFAULT_POLICY: TelegramFanoutPolicy = { concurrency: 3, intervalMs: 100 };

function stoppedError(): DOMException {
  return new DOMException("Telegram fan-out stopped", "AbortError");
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(stoppedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    timer.unref?.();
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(stoppedError()); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One process-wide gate for notification fan-out. It bounds active Telegram
 * mutations and spaces their start times; Telegram retry and 429 policy stays
 * entirely inside TelegramApiClient/OutboundHttpClient.
 */
export class TelegramFanoutService implements TelegramSender {
  private active = 0;
  private nextStartAt = 0;
  private pacingTail: Promise<void> = Promise.resolve();
  private readonly waiters: Array<{ resolve: (release: () => void) => void; reject: (error: unknown) => void }> = [];
  private readonly controller = new AbortController();

  constructor(
    private readonly telegram: TelegramSender,
    private readonly policy: TelegramFanoutPolicy = DEFAULT_POLICY,
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void> = abortableDelay,
  ) {}

  async sendMessage(chatId: number, message: string, options?: TelegramMessageOptions): Promise<void> {
    const release = await this.acquire();
    try {
      await this.pace();
      if (options === undefined) await this.telegram.sendMessage(chatId, message);
      else await this.telegram.sendMessage(chatId, message, options);
    } finally {
      release();
    }
  }

  async sendAll(requests: readonly TelegramFanoutRequest[]): Promise<PromiseSettledResult<void>[]> {
    if (requests.length === 0) return [];
    const outcomes = new Array<PromiseSettledResult<void>>(requests.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.policy.concurrency, requests.length) }, async () => {
      while (!this.controller.signal.aborted) {
        const index = cursor;
        if (index >= requests.length) return;
        cursor += 1;
        const request = requests[index]!;
        try {
          await this.sendMessage(request.chatId, request.message, request.options);
          outcomes[index] = { status: "fulfilled", value: undefined };
        } catch (reason) {
          outcomes[index] = { status: "rejected", reason };
        }
      }
    });
    await Promise.all(workers);
    for (let index = cursor; index < requests.length; index += 1) {
      outcomes[index] = { status: "rejected", reason: stoppedError() };
    }
    return outcomes;
  }

  stop(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    for (const waiter of this.waiters.splice(0)) waiter.reject(stoppedError());
  }

  private acquire(): Promise<() => void> {
    if (this.controller.signal.aborted) return Promise.reject(stoppedError());
    if (this.active < this.policy.concurrency) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private pace(): Promise<void> {
    const turn = this.pacingTail.then(async () => {
      if (this.controller.signal.aborted) throw stoppedError();
      await this.sleep(Math.max(0, this.nextStartAt - this.now()), this.controller.signal);
      if (this.controller.signal.aborted) throw stoppedError();
      // Base the next slot on the actual start time. Timer callbacks can bunch
      // together after an event-loop stall, so pre-reserving parallel slots
      // would not guarantee a real minimum interval on a busy VPS.
      this.nextStartAt = this.now() + this.policy.intervalMs;
    });
    this.pacingTail = turn.catch(() => undefined);
    return turn;
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const waiter = this.waiters.shift();
      if (!waiter || this.controller.signal.aborted) return;
      this.active += 1;
      waiter.resolve(this.releaseFunction());
    };
  }
}
