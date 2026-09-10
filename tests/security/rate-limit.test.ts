import { describe, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "../../src/http/rate-limit.js";
import { normalizeIp } from "../../src/http/rate-limit-policy.js";

describe("P1-03 token bucket", () => {
  it("RL-01 permits capacity and refuses the next request", () => {
    const limiter = new TokenBucketLimiter(10, () => 0);
    const policy = { capacity: 3, refillPeriodMs: 60_000 };
    expect([1, 2, 3].map(() => limiter.consume("a", policy).allowed)).toEqual([true, true, true]);
    expect(limiter.consume("a", policy).allowed).toBe(false);
  });

  it("RL-02 refills continuously from monotonic elapsed time", () => {
    let now = 1_000;
    const limiter = new TokenBucketLimiter(10, () => now);
    const policy = { capacity: 60, refillPeriodMs: 60_000 };
    for (let index = 0; index < 60; index += 1) limiter.consume("a", policy);
    now += 999;
    expect(limiter.consume("a", policy).allowed).toBe(false);
    now += 1;
    expect(limiter.consume("a", policy).allowed).toBe(true);
    now -= 5_000;
    expect(limiter.consume("a", policy).allowed).toBe(false);
  });

  it("RL-03 returns bounded integer retry metadata", () => {
    const limiter = new TokenBucketLimiter(10, () => 0);
    const policy = { capacity: 5, refillPeriodMs: 60_000 };
    for (let index = 0; index < 5; index += 1) limiter.consume("a", policy);
    const result = limiter.consume("a", policy);
    expect(Number.isInteger(result.retryAfterSeconds)).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("RL-04 maintains independent key budgets", () => {
    const limiter = new TokenBucketLimiter(10, () => 0);
    const policy = { capacity: 1, refillPeriodMs: 60_000 };
    expect(limiter.consume("a", policy).allowed).toBe(true);
    expect(limiter.consume("a", policy).allowed).toBe(false);
    expect(limiter.consume("b", policy).allowed).toBe(true);
  });

  it("RL-05 sweeps full buckets before LRU eviction and never exceeds its cap", () => {
    let now = 0;
    const pressure = vi.fn();
    const limiter = new TokenBucketLimiter(2, () => now, pressure);
    const policy = { capacity: 1, refillPeriodMs: 100 };
    limiter.consume("stale", policy);
    now = 100;
    limiter.consume("kept", policy);
    limiter.consume("new", policy);
    expect(limiter.size).toBe(2);
    expect(pressure).not.toHaveBeenCalled();
    now = 101;
    limiter.consume("kept", policy);
    limiter.consume("third", policy);
    expect(limiter.size).toBe(2);
    expect(pressure).toHaveBeenCalledOnce();
    expect(limiter.consume("new", policy).allowed).toBe(true);
    expect(limiter.size).toBe(2);
  });

  it("RL-05 does not double-count refill time when sweeping a partial bucket", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(2, () => now);
    const policy = { capacity: 4, refillPeriodMs: 100 };
    for (let index = 0; index < 4; index += 1) limiter.consume("partial", policy);
    now = 25; limiter.sweep();
    now = 50;
    expect(limiter.consume("partial", policy).allowed).toBe(true);
    expect(limiter.consume("partial", policy).allowed).toBe(true);
    expect(limiter.consume("partial", policy).allowed).toBe(false);
  });

  it("RL-06 normalizes IPv6 addresses to /64 keys", () => {
    expect(normalizeIp("2001:db8:abcd:12::1")).toBe(normalizeIp("2001:0db8:abcd:0012:ffff::9"));
    expect(normalizeIp("2001:db8:abcd:12::1")).not.toBe(normalizeIp("2001:db8:abcd:13::1"));
    expect(normalizeIp("::ffff:192.0.2.4")).toBe(normalizeIp("0:0:0:0:ffff:c000:0204:1"));
    expect(normalizeIp("192.0.2.4")).toBe("192.0.2.4");
  });
});
