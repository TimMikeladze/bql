/**
 * Rate limiting, in process and in memory.
 *
 * A token bucket per credential, not per connection: the thing worth limiting
 * is "how much of the bus may this tenant use", and a caller that opens more
 * sockets should not thereby get more of it.
 *
 * Deliberately **not** persisted. A restarted bus forgetting that a token was
 * being throttled for the last few seconds is an acceptable loss; writing a
 * row per request to bound requests is not. The cost of that choice is stated
 * rather than hidden: limits are per process, so two processes in front of one
 * database would each allow the full rate — which is also true of every other
 * in-memory limiter, and the bus is one writer anyway.
 */

export interface RateLimit {
  /** Sustained rate. 0 disables the limit entirely. */
  perSecond: number;
  /** How much may arrive at once after an idle period. */
  burst: number;
}

export interface Decision {
  ok: boolean;
  /** How long to wait, for `Retry-After`. Zero when `ok`. */
  retryAfterMs: number;
}

export interface Limiter {
  take(key: string, cost?: number): Decision;
  /** Drop buckets nobody has touched, so an unbounded key space cannot leak. */
  sweep(olderThanMs?: number): void;
  size(): number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export function tokenBucket(
  limit: RateLimit,
  now: () => number = Date.now,
): Limiter {
  const buckets = new Map<string, Bucket>();
  return {
    take(key, cost = 1) {
      if (limit.perSecond <= 0) return { ok: true, retryAfterMs: 0 };
      const at = now();
      const bucket = buckets.get(key) ?? { tokens: limit.burst, at };
      // Refill by elapsed time rather than on a timer: a bucket nobody has
      // touched costs nothing, and there is no interval to leak.
      const refill = ((at - bucket.at) / 1000) * limit.perSecond;
      bucket.tokens = Math.min(limit.burst, bucket.tokens + refill);
      bucket.at = at;
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        buckets.set(key, bucket);
        return { ok: true, retryAfterMs: 0 };
      }
      buckets.set(key, bucket);
      const deficit = cost - bucket.tokens;
      return {
        ok: false,
        retryAfterMs: Math.max(1, Math.ceil((deficit / limit.perSecond) * 1000)),
      };
    },
    sweep(olderThanMs = 5 * 60_000) {
      const cutoff = now() - olderThanMs;
      for (const [key, bucket] of buckets)
        if (bucket.at < cutoff) buckets.delete(key);
    },
    size: () => buckets.size,
  };
}

/**
 * A ceiling on concurrent holders of something, by key.
 *
 * Used for parked long polls: a claim with `waitMs` occupies a request slot for
 * as long as it waits, so one consumer opening a hundred of them can take the
 * server's whole poll budget without breaking any rate limit at all.
 */
export interface Gate {
  enter(key: string): boolean;
  leave(key: string): void;
  held(key: string): number;
}

export function gate(max: number): Gate {
  const held = new Map<string, number>();
  return {
    enter(key) {
      if (max <= 0) return true;
      const current = held.get(key) ?? 0;
      if (current >= max) return false;
      held.set(key, current + 1);
      return true;
    },
    leave(key) {
      const current = held.get(key) ?? 0;
      if (current <= 1) held.delete(key);
      else held.set(key, current - 1);
    },
    held: (key) => held.get(key) ?? 0,
  };
}
