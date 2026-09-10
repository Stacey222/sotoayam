export interface TokenBucketPolicy { capacity: number; refillPeriodMs: number }
export interface TokenBucketResult {
  allowed: boolean; retryAfterSeconds: number; remaining: number; resetSeconds: number;
}
interface BucketState { tokens: number; updatedAt: number; policy: TokenBucketPolicy }

/** Dependency-free, synchronous token bucket. Keys and timers are owned by the Fastify adapter. */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, BucketState>();

  constructor(private readonly maxKeys: number, private readonly now: () => number = Date.now,
    private readonly onCapacityPressure?: () => void) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error("maxKeys must be a positive integer");
  }

  get size(): number { return this.buckets.size; }

  consume(key: string, policy: TokenBucketPolicy, cost = 1): TokenBucketResult {
    if (!Number.isFinite(cost) || cost <= 0) throw new Error("cost must be positive");
    const now = this.now();
    let state = this.buckets.get(key);
    if (!state) {
      this.makeRoom();
      state = { tokens: policy.capacity, updatedAt: now, policy };
      this.buckets.set(key, state);
    } else {
      this.refill(state, policy, now);
      state.policy = policy;
    }
    const allowed = state.tokens >= cost;
    if (allowed) state.tokens -= cost;
    state.updatedAt = Math.max(state.updatedAt, now);
    return this.result(state.tokens, policy, cost, allowed);
  }

  /** Checks whether a later consume could succeed without charging a successful request. */
  inspect(key: string, policy: TokenBucketPolicy, cost = 1): TokenBucketResult {
    const state = this.buckets.get(key);
    if (!state) return this.result(policy.capacity, policy, cost, true);
    const now = this.now();
    this.refill(state, policy, now);
    state.policy = policy;
    state.updatedAt = Math.max(state.updatedAt, now);
    return this.result(state.tokens, policy, cost, state.tokens >= cost);
  }

  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, state] of this.buckets) {
      const elapsed = Math.max(0, now - state.updatedAt);
      const projectedTokens = Math.min(state.policy.capacity,
        state.tokens + elapsed * state.policy.capacity / state.policy.refillPeriodMs);
      if (projectedTokens >= state.policy.capacity) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void { this.buckets.clear(); }

  private refill(state: BucketState, policy: TokenBucketPolicy, now: number): void {
    const elapsed = Math.max(0, now - state.updatedAt);
    state.tokens = Math.min(policy.capacity, state.tokens + elapsed * policy.capacity / policy.refillPeriodMs);
  }

  private result(tokens: number, policy: TokenBucketPolicy, cost: number, allowed: boolean): TokenBucketResult {
    const refillPerMs = policy.capacity / policy.refillPeriodMs;
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((cost - tokens) / refillPerMs / 1_000)),
      remaining: Math.max(0, Math.floor(tokens)),
      resetSeconds: Math.max(1, Math.ceil((policy.capacity - tokens) / refillPerMs / 1_000)),
    };
  }

  private makeRoom(): void {
    if (this.buckets.size < this.maxKeys) return;
    this.sweep();
    if (this.buckets.size < this.maxKeys) return;
    let oldest: [string, BucketState] | undefined;
    for (const entry of this.buckets) {
      if (!oldest || entry[1].updatedAt < oldest[1].updatedAt) oldest = entry;
    }
    if (oldest) this.buckets.delete(oldest[0]);
    this.onCapacityPressure?.();
  }
}
