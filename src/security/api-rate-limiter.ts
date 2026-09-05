export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface RateLimitEntry {
  startedAt: number;
  count: number;
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
    private readonly maxTrackedClients: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(clientKey: string): RateLimitResult {
    const now = this.now();
    this.prune(now);
    let entry = this.entries.get(clientKey);
    if (!entry || now - entry.startedAt >= this.windowMs) {
      entry = { startedAt: now, count: 0 };
      this.entries.delete(clientKey);
      this.entries.set(clientKey, entry);
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((entry.startedAt + this.windowMs - now) / 1000));
    if (entry.count >= this.maxRequests) {
      return { allowed: false, limit: this.maxRequests, remaining: 0, retryAfterSeconds };
    }

    entry.count += 1;
    return { allowed: true, limit: this.maxRequests, remaining: this.maxRequests - entry.count, retryAfterSeconds };
  }

  trackedClientCount(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.startedAt >= this.windowMs) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxTrackedClients) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) return;
      this.entries.delete(oldest);
    }
  }
}
