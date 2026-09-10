export const DEFAULT_OUTBOUND_TIMEOUT_MS = 10_000;
export const DEFAULT_OUTBOUND_MAX_RETRIES = 2;
export const MAX_OUTBOUND_RETRIES = 3;
export const MAX_OUTBOUND_RETRY_DELAY_MS = 60_000;

export type OutboundErrorKind = "TIMEOUT" | "NETWORK" | "HTTP" | "ABORTED";
export type OutboundRetryMode = "safe" | "rate-limit-only" | "none";

export class OutboundHttpError extends Error {
  readonly code: `OUTBOUND_${OutboundErrorKind}`;

  constructor(
    public readonly kind: OutboundErrorKind,
    public readonly attempts: number,
    public readonly retryable: boolean,
    public readonly retryExhausted: boolean,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number,
    public readonly response?: Response,
  ) {
    super(kind === "HTTP" && statusCode !== undefined
      ? `Outbound HTTP request failed with status ${statusCode}`
      : `Outbound HTTP request failed: ${kind}`);
    this.name = "OutboundHttpError";
    this.code = `OUTBOUND_${kind}`;
  }
}

export interface OutboundRequestOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  retryMode?: OutboundRetryMode;
  retryAfterMs?: (response: Response) => number | null | Promise<number | null>;
}

export interface OutboundHttpClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function validDelay(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : null;
}

export class OutboundHttpClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(options: OutboundHttpClientOptions = {}) {
    this.timeoutMs = boundedInteger("timeoutMs", options.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS, 1, 120_000);
    this.maxRetries = boundedInteger("maxRetries", options.maxRetries ?? DEFAULT_OUTBOUND_MAX_RETRIES, 0, MAX_OUTBOUND_RETRIES);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((delayMs, signal) => new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    }));
    this.now = options.now ?? Date.now;
  }

  async request(input: string | URL | Request, options: OutboundRequestOptions = {}): Promise<Response> {
    const { timeoutMs: requestedTimeout, maxRetries: requestedRetries, retryMode: requestedMode,
      retryAfterMs: customRetryAfter, ...init } = options;
    const timeoutMs = boundedInteger("timeoutMs", requestedTimeout ?? this.timeoutMs, 1, 120_000);
    const maxRetries = boundedInteger("maxRetries", requestedRetries ?? this.maxRetries, 0, MAX_OUTBOUND_RETRIES);
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const retryMode = requestedMode ?? (SAFE_METHODS.has(method) ? "safe" : "none");
    const maximumAttempts = maxRetries + 1;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (init.signal?.aborted) throw new OutboundHttpError("ABORTED", attempt, false, false);
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      init.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const response = await this.fetchImpl(input, { ...init, signal: controller.signal });
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onAbort);
        if (response.ok) return response;
        const retryable = this.isRetryableResponse(response.status, retryMode, method);
        const retryAfter = retryable
          ? await this.retryDelay(response, customRetryAfter, attempt)
          : undefined;
        if (retryable && attempt < maximumAttempts && retryAfter! <= MAX_OUTBOUND_RETRY_DELAY_MS) {
          await this.wait(retryAfter!, init.signal, attempt);
          continue;
        }
        throw new OutboundHttpError("HTTP", attempt, retryable, retryable && attempt >= maximumAttempts,
          response.status, retryAfter, response);
      } catch (error) {
        if (error instanceof OutboundHttpError) throw error;
        const externallyAborted = init.signal?.aborted === true && !timedOut;
        const kind: OutboundErrorKind = externallyAborted ? "ABORTED" : timedOut ? "TIMEOUT" : "NETWORK";
        const retryable = retryMode === "safe" && SAFE_METHODS.has(method) && kind !== "ABORTED";
        if (retryable && attempt < maximumAttempts) {
          await this.wait(this.backoff(attempt), init.signal, attempt);
          continue;
        }
        throw new OutboundHttpError(kind, attempt, retryable, retryable && attempt >= maximumAttempts);
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onAbort);
      }
    }
    throw new Error("Outbound HTTP attempt bound was violated");
  }

  private isRetryableResponse(status: number, mode: OutboundRetryMode, method: string): boolean {
    if (mode === "rate-limit-only") return status === 429;
    return mode === "safe" && SAFE_METHODS.has(method) && TRANSIENT_STATUSES.has(status);
  }

  private async retryDelay(response: Response,
    custom: OutboundRequestOptions["retryAfterMs"], attempt: number): Promise<number> {
    const customValue = validDelay(custom ? await Promise.resolve(custom(response.clone())).catch(() => null) : null);
    const headerValue = validDelay(parseRetryAfter(response.headers.get("retry-after"), this.now()));
    // Multiple server hints are independent lower bounds. Waiting for their maximum is
    // conservative; a value above the local cap is returned unchanged and suppresses retry.
    return customValue === null && headerValue === null
      ? this.backoff(attempt)
      : Math.max(customValue ?? 0, headerValue ?? 0);
  }

  private async wait(delayMs: number, signal: AbortSignal | null | undefined, attempt: number): Promise<void> {
    if (signal?.aborted) throw new OutboundHttpError("ABORTED", attempt, false, false);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      onAbort = () => reject(new OutboundHttpError("ABORTED", attempt, false, false));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([this.sleep(delayMs, signal ?? undefined), aborted]);
    } catch (error) {
      if (signal?.aborted) throw new OutboundHttpError("ABORTED", attempt, false, false);
      throw error;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(250 * (2 ** (attempt - 1)), 2_000);
  }
}
