/**
 * In-memory token bucket: the primitive every rate limit in Kiri is built from.
 *
 * Callers today:
 * - `src/lib/auth/rate-limits.ts` — the auth perimeter (sign-in, sign-up,
 *   change/forget password, invite claiming, set-password), which combines a
 *   per-identity, a per-client and a global bucket.
 * - `src/app/api/series/route.ts` — per-user cap on library writes.
 * - `src/lib/jikan.ts` — outbound politeness towards the Jikan API.
 *
 * Deliberately per-process: Kiri is a single self-hosted instance, so a shared
 * store would be more moving parts than the threat model needs. The map is
 * bounded (idle keys expire, hard cap on entries) so a flood of distinct keys
 * cannot grow it without limit. Restarting the process forgets every bucket,
 * which is acceptable for the abuse this is meant to blunt.
 *
 * This module deliberately imports nothing from the app: the auth stack
 * (`src/lib/auth/server.ts`) depends on it, and `src/lib/api.ts` depends on the
 * auth stack, so reaching for `jsonResponse` here would close an import cycle
 * that leaves half-initialised bindings behind.
 */

export interface RateLimitOptions {
  /** Burst size: how many requests are allowed back-to-back. */
  capacity: number;
  /** Sustained rate, tokens added per second. */
  refillPerSecond: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 0 when allowed; otherwise how long until one token is available. */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const IDLE_TTL_MS = 10 * 60 * 1000;
const MAX_KEYS = 10_000;
const SWEEP_INTERVAL_MS = 60 * 1000;

const buckets = new Map<string, Bucket>();
let lastSweepAt = 0;

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > IDLE_TTL_MS) {
      buckets.delete(key);
    }
  }
  if (buckets.size <= MAX_KEYS) return;
  // Still over the cap: drop the least recently used entries.
  const byAge = [...buckets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [key] of byAge.slice(0, buckets.size - MAX_KEYS)) {
    buckets.delete(key);
  }
}

/**
 * Consume one token for `key`. Unknown keys start full, so the first
 * `capacity` requests always pass.
 */
export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = (opts.now ?? Date.now)();
  const capacity = Math.max(1, opts.capacity);
  const refillPerSecond = Math.max(0, opts.refillPerSecond);

  if (now - lastSweepAt > SWEEP_INTERVAL_MS || buckets.size >= MAX_KEYS) {
    lastSweepAt = now;
    sweep(now);
  }

  const existing = buckets.get(key);
  const bucket: Bucket = existing ?? { tokens: capacity, updatedAt: now };
  const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
  bucket.updatedAt = now;
  buckets.set(key, bucket);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  const missing = 1 - bucket.tokens;
  const retryAfterMs =
    refillPerSecond > 0 ? Math.ceil((missing / refillPerSecond) * 1000) : Number.POSITIVE_INFINITY;
  return { allowed: false, retryAfterMs };
}

/** Test helper: forget every bucket. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweepAt = 0;
}

/** Test/introspection helper: number of tracked keys. */
export function rateLimitSize(): number {
  return buckets.size;
}

/** 429 in the standard error shape, with a Retry-After header in seconds. */
export function rateLimitedResponse(retryAfterMs: number): Response {
  const seconds = Number.isFinite(retryAfterMs) ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : 60;
  const body = {
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Please slow down and try again.",
      details: { retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : seconds * 1000 },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(seconds),
      "Cache-Control": "no-store",
    },
  });
}
