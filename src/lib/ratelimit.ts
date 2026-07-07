/**
 * Runtime-agnostic abuse protection primitives.
 *
 * Two small, dependency-free building blocks used by the app to bound the two
 * unbounded surfaces a senior reviewer flags first:
 *
 *   - `TokenBucket` — a classic token-bucket rate limiter keyed by an arbitrary
 *     string (typically `ip:routeClass`). Refills continuously, so a client that
 *     backs off recovers capacity smoothly rather than in fixed windows.
 *   - `ConnectionCounter` — a per-key gauge used to cap the number of concurrent
 *     SSE subscribers a single IP may hold open.
 *
 * Both are pure JS (a `Map` + `Date.now()`), so they behave identically on Bun,
 * Deno and Node. For a single-instance starter this is exactly right; the README
 * documents swapping in a shared store (Redis) for multi-instance deployments.
 */

export interface RateLimitResult {
  /** True when the request is allowed. */
  ok: boolean;
  /** Tokens remaining in the bucket after this check (floored). */
  remaining: number;
  /** Seconds until at least one token is available again (0 when allowed). */
  retryAfter: number;
  /** Configured bucket capacity, surfaced as `X-RateLimit-Limit`. */
  limit: number;
}

export interface TokenBucketOptions {
  /** Max tokens (burst size). */
  capacity: number;
  /** Tokens added per second (sustained rate). */
  refillPerSecond: number;
}

interface BucketState {
  tokens: number;
  last: number; // ms epoch of the last refill
}

export class TokenBucket {
  private readonly buckets = new Map<string, BucketState>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions, now: () => number = Date.now) {
    this.capacity = Math.max(1, opts.capacity);
    this.refillPerSecond = Math.max(0.001, opts.refillPerSecond);
    this.now = now;
  }

  /** Attempt to consume one token for `key`. */
  take(key: string, cost = 1): RateLimitResult {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: t };
      this.buckets.set(key, b);
    } else {
      // Continuous refill since the last check.
      const elapsedSec = (t - b.last) / 1000;
      b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSecond);
      b.last = t;
    }

    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens), retryAfter: 0, limit: this.capacity };
    }

    const deficit = cost - b.tokens;
    const retryAfter = Math.ceil(deficit / this.refillPerSecond);
    return { ok: false, remaining: Math.floor(b.tokens), retryAfter, limit: this.capacity };
  }

  /** Drop idle buckets to keep memory bounded under many distinct keys. */
  sweep(maxIdleMs = 10 * 60_000): void {
    const cutoff = this.now() - maxIdleMs;
    for (const [key, b] of this.buckets) {
      if (b.last < cutoff && b.tokens >= this.capacity) this.buckets.delete(key);
    }
  }

  /** Number of tracked keys (diagnostics/tests). */
  size(): number {
    return this.buckets.size;
  }
}

/**
 * A per-key concurrency gauge. Used to cap simultaneous SSE connections per IP.
 * `acquire` returns a release function, or `null` when the key is at capacity.
 */
export class ConnectionCounter {
  private readonly counts = new Map<string, number>();
  private readonly max: number;

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  acquire(key: string): (() => void) | null {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.max) return null;
    this.counts.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.counts.get(key) ?? 1) - 1;
      if (n <= 0) this.counts.delete(key);
      else this.counts.set(key, n);
    };
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  total(): number {
    let n = 0;
    for (const c of this.counts.values()) n += c;
    return n;
  }
}
