import { describe, expect, it, vi } from "vitest";
import {
  MAX_OUTBOUND_RETRIES,
  OutboundHttpClient,
  OutboundHttpError,
} from "../../src/http/outbound-http-client.js";

function response(status: number): Response {
  return new Response(null, { status });
}

describe("shared outbound HTTP client", () => {
  it("aborts an attempt at its explicit timeout and classifies the final error", async () => {
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const client = new OutboundHttpClient({ fetch: fetch as typeof globalThis.fetch, timeoutMs: 5, maxRetries: 0 });

    const error = await client.request("https://example.test").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "OUTBOUND_TIMEOUT", kind: "TIMEOUT", attempts: 1,
      retryable: true, retryExhausted: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries a transient safe request and returns its eventual success", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(response(200));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new OutboundHttpClient({ fetch, sleep, maxRetries: 2 });

    expect((await client.request("https://example.test/status")).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250, undefined);
  });

  it("stops after the configured retry bound and returns a deterministic exhausted error", async () => {
    const fetch = vi.fn().mockResolvedValue(response(503));
    const client = new OutboundHttpClient({ fetch, sleep: async () => undefined, maxRetries: 2 });

    const error = await client.request("https://example.test/status").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundHttpError);
    expect(error).toMatchObject({ code: "OUTBOUND_HTTP", message: "Outbound HTTP request failed with status 503",
      kind: "HTTP", statusCode: 503, attempts: 3, retryable: true, retryExhausted: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable 4xx response", async () => {
    const fetch = vi.fn().mockResolvedValue(response(400));
    const client = new OutboundHttpClient({ fetch, sleep: async () => undefined });

    const error = await client.request("https://example.test/status").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "OUTBOUND_HTTP", statusCode: 400, attempts: 1,
      retryable: false, retryExhausted: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never retries an unsafe POST after an ambiguous network failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("socket closed"));
    const client = new OutboundHttpClient({ fetch, sleep: async () => undefined });

    const error = await client.request("https://example.test/action", { method: "POST", body: "{}" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "OUTBOUND_NETWORK", attempts: 1, retryable: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never retries an unsafe POST after its timeout", async () => {
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const client = new OutboundHttpClient({ fetch: fetch as typeof globalThis.fetch, timeoutMs: 5 });

    const error = await client.request("https://example.test/action", {
      method: "POST", body: "{}", retryMode: "rate-limit-only",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "OUTBOUND_TIMEOUT", attempts: 1, retryable: false,
      retryExhausted: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels a pending 429 retry wait without starting another attempt", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(response(429));
    const sleep = vi.fn(() => new Promise<void>(() => undefined));
    const client = new OutboundHttpClient({ fetch, sleep, maxRetries: 2 });
    const pending = client.request("https://example.test/action", {
      method: "POST", retryMode: "rate-limit-only", signal: controller.signal,
    }).catch((caught: unknown) => caught);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());

    controller.abort();
    const error = await pending;

    expect(error).toMatchObject({ code: "OUTBOUND_ABORTED", kind: "ABORTED", attempts: 1 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry before a server delay above the local wait cap", async () => {
    const fetch = vi.fn().mockResolvedValue(response(429));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new OutboundHttpClient({ fetch, sleep, maxRetries: 2 });

    const error = await client.request("https://example.test/action", {
      method: "POST", retryMode: "rate-limit-only", retryAfterMs: () => 61_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OutboundHttpError);
    expect(error).toMatchObject({ code: "OUTBOUND_HTTP", statusCode: 429, attempts: 1,
      retryable: true, retryExhausted: false, retryAfterMs: 61_000 });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("parses an HTTP-date Retry-After value", async () => {
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503,
        headers: { "retry-after": "Wed, 10 Sep 2026 00:00:05 GMT" } }))
      .mockResolvedValueOnce(response(200));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new OutboundHttpClient({ fetch, sleep, now: () => now });

    await client.request("https://example.test/status");

    expect(sleep).toHaveBeenCalledWith(5_000, undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects retry configurations that could exceed the hard global bound", () => {
    expect(() => new OutboundHttpClient({ maxRetries: MAX_OUTBOUND_RETRIES + 1 }))
      .toThrow(`maxRetries must be an integer between 0 and ${MAX_OUTBOUND_RETRIES}`);
  });
});
