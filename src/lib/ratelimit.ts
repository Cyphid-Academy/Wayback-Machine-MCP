export interface RateLimitGrant {
  readonly ok: true;
  readonly waitedMs: number;
}

export interface RateLimitDenial {
  readonly ok: false;
  readonly retryAfterMs: number;
}

export type RateLimitOutcome = RateLimitGrant | RateLimitDenial;

export interface RateLimiter {
  /**
   * Reserves one upstream request slot, sleeping up to `maxWaitMs` for capacity.
   * Denies rather than throwing when the wait would be longer than that — callers
   * absorb the wait as latency, and only a genuinely long queue becomes an error.
   */
  acquire(maxWaitMs: number): Promise<RateLimitOutcome>;
  /** Called when upstream says 429/503: blocks new requests for `ms`. */
  penalize(ms: number): void;
  /** How many callers are currently queued behind the bucket. */
  queueDepth(): number;
}

export interface TokenBucketOptions {
  readonly capacity: number;
  readonly refillPerMinute: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Token bucket with pessimistic reservation: a caller decrements the balance
 * immediately (possibly into deficit) and then sleeps off its own deficit, so
 * concurrent callers queue instead of all seeing the same free token.
 */
export class InMemoryTokenBucket implements RateLimiter {
  private readonly capacity: number;
  private readonly tokensPerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefill: number;
  private blockedUntil = 0;
  private queued = 0;

  constructor(options: TokenBucketOptions) {
    this.capacity = Math.max(1, options.capacity);
    this.tokensPerMs = Math.max(options.refillPerMinute, 1) / 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  queueDepth(): number {
    return this.queued;
  }

  async acquire(maxWaitMs: number): Promise<RateLimitOutcome> {
    this.refill();

    const penaltyMs = Math.max(0, this.blockedUntil - this.now());
    if (penaltyMs > maxWaitMs) return { ok: false, retryAfterMs: penaltyMs };

    this.tokens -= 1;
    const deficitMs = this.tokens >= 0 ? 0 : -this.tokens / this.tokensPerMs;
    const waitMs = Math.max(penaltyMs, deficitMs);

    if (waitMs > maxWaitMs) {
      this.tokens += 1;
      return { ok: false, retryAfterMs: Math.ceil(waitMs) };
    }
    if (waitMs > 0) {
      this.queued += 1;
      try {
        await this.sleep(Math.ceil(waitMs));
      } finally {
        this.queued -= 1;
      }
    }
    return { ok: true, waitedMs: Math.ceil(waitMs) };
  }

  penalize(ms: number): void {
    if (ms <= 0) return;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  /** Exposed for diagnostics and tests. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.tokensPerMs);
  }
}
