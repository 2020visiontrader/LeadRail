// In-process sliding-window rate limiter.
//
// Exists because /api/contact and /api/auth/signup are the first PUBLIC write
// endpoints in the app — everything else sits behind requireSession. An
// unauthenticated endpoint that sends email or creates an account is exactly
// what gets found and abused, so neither ships without a limit.
//
// HONEST ABOUT ITS LIMITS. This is per-process memory, so it does NOT hold
// across a restart and does NOT coordinate between instances. LeadRail runs a
// single `next start`, so today that is the whole system and the limit is real.
// If this is ever load-balanced, this must move to Postgres or Redis or it
// silently multiplies the effective limit by the instance count.
//
// It is a floor, not a shield. It stops casual abuse and accidental loops; it
// does not stop a distributed attacker, and it is not a substitute for the
// spend/approval gates that protect anything expensive.

interface Bucket { hits: number[] }

const buckets = new Map<string, Bucket>();
// Bound the map so a spray of unique keys cannot grow it without limit.
const MAX_KEYS = 10_000;

export interface RateLimitResult {
  ok: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** Seconds until the window frees up. 0 when ok. */
  retryAfter: number;
}

/**
 * @param key     caller identity — an IP, or IP+route. Never a raw email: that
 *                would let an attacker lock a victim out by guessing it.
 * @param limit   requests allowed per window
 * @param windowMs window length in milliseconds
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;

  if (buckets.size > MAX_KEYS) {
    // Cheapest correct eviction: drop everything already expired. If that frees
    // nothing (all buckets live), clear outright rather than grow unbounded —
    // being briefly permissive beats leaking memory in a long-lived process.
    for (const [k, b] of buckets) {
      if (!b.hits.some((t) => t > cutoff)) buckets.delete(k);
    }
    if (buckets.size > MAX_KEYS) buckets.clear();
  }

  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    const oldest = bucket.hits[0];
    return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  return { ok: true, remaining: limit - bucket.hits.length, retryAfter: 0 };
}

/** Best-effort client IP from proxy headers. Falls back to a constant, which
 *  makes the limiter global rather than per-caller — degrading to "too strict"
 *  rather than "no limit at all". */
export function clientIp(req: Request): string {
  const h = req.headers;
  const fwd = h.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return h.get('x-real-ip') || h.get('cf-connecting-ip') || 'unknown';
}

/** Test seam: clears all windows. */
export function __resetRateLimits() { buckets.clear(); }
