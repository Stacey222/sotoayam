import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../../src/security/api-rate-limiter.js";

describe("FixedWindowRateLimiter", () => {
  it("limits each client independently and resets after its window", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(1_000, 2, 10, () => now);
    expect(limiter.check("127.0.0.1")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("127.0.0.1")).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.check("127.0.0.1")).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.check("127.0.0.2")).toMatchObject({ allowed: true, remaining: 1 });
    now = 1_000;
    expect(limiter.check("127.0.0.1")).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("expires and caps tracked client state", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(100, 1, 2, () => now);
    limiter.check("first");
    limiter.check("second");
    limiter.check("third");
    expect(limiter.trackedClientCount()).toBe(2);
    now = 100;
    limiter.check("fourth");
    expect(limiter.trackedClientCount()).toBe(1);
  });
});
