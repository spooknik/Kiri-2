import { beforeEach, describe, expect, it } from "vitest";
import {
  checkRateLimit,
  rateLimitSize,
  rateLimitedResponse,
  resetRateLimits,
} from "@/lib/rate-limit";

/** Test clock: advance manually so refills are deterministic. */
function clock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

beforeEach(() => {
  resetRateLimits();
});

describe("checkRateLimit", () => {
  it("allows a full burst then denies", () => {
    const time = clock();
    const opts = { capacity: 3, refillPerSecond: 1, now: time.now };

    expect(checkRateLimit("ip:1", opts).allowed).toBe(true);
    expect(checkRateLimit("ip:1", opts).allowed).toBe(true);
    expect(checkRateLimit("ip:1", opts).allowed).toBe(true);

    const denied = checkRateLimit("ip:1", opts);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000);
  });

  it("refills over time", () => {
    const time = clock();
    const opts = { capacity: 2, refillPerSecond: 2, now: time.now };

    expect(checkRateLimit("ip:2", opts).allowed).toBe(true);
    expect(checkRateLimit("ip:2", opts).allowed).toBe(true);
    expect(checkRateLimit("ip:2", opts).allowed).toBe(false);

    time.advance(500); // one token at 2/s
    expect(checkRateLimit("ip:2", opts).allowed).toBe(true);
    expect(checkRateLimit("ip:2", opts).allowed).toBe(false);
  });

  it("never refills above capacity", () => {
    const time = clock();
    const opts = { capacity: 2, refillPerSecond: 1, now: time.now };

    expect(checkRateLimit("ip:3", opts).allowed).toBe(true);
    time.advance(60_000);
    expect(checkRateLimit("ip:3", opts).allowed).toBe(true);
    expect(checkRateLimit("ip:3", opts).allowed).toBe(true);
    expect(checkRateLimit("ip:3", opts).allowed).toBe(false);
  });

  it("reports a shrinking retryAfterMs as the bucket refills", () => {
    const time = clock();
    const opts = { capacity: 1, refillPerSecond: 0.5, now: time.now };

    expect(checkRateLimit("ip:4", opts).allowed).toBe(true);
    expect(checkRateLimit("ip:4", opts).retryAfterMs).toBe(2000);
    time.advance(1000);
    expect(checkRateLimit("ip:4", opts).retryAfterMs).toBe(1000);
  });

  it("keeps buckets per key", () => {
    const time = clock();
    const opts = { capacity: 1, refillPerSecond: 1, now: time.now };

    expect(checkRateLimit("a", opts).allowed).toBe(true);
    expect(checkRateLimit("b", opts).allowed).toBe(true);
    expect(checkRateLimit("a", opts).allowed).toBe(false);
  });

  it("reports an infinite wait when nothing refills", () => {
    const time = clock();
    const opts = { capacity: 1, refillPerSecond: 0, now: time.now };

    expect(checkRateLimit("frozen", opts).allowed).toBe(true);
    expect(checkRateLimit("frozen", opts).retryAfterMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("evicts idle keys so the map stays bounded", () => {
    const time = clock();
    const opts = { capacity: 1, refillPerSecond: 1, now: time.now };

    checkRateLimit("old-1", opts);
    checkRateLimit("old-2", opts);
    expect(rateLimitSize()).toBe(2);

    time.advance(11 * 60 * 1000); // past the 10 minute idle TTL
    checkRateLimit("fresh", opts);

    expect(rateLimitSize()).toBe(1);
  });
});

describe("rateLimitedResponse", () => {
  it("is a 429 with a Retry-After header in seconds", async () => {
    const res = rateLimitedResponse(2500);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED", details: { retryAfterMs: 2500 } },
    });
  });

  it("never advertises a zero second wait", () => {
    expect(rateLimitedResponse(0).headers.get("Retry-After")).toBe("1");
    expect(rateLimitedResponse(Number.POSITIVE_INFINITY).headers.get("Retry-After")).toBe("60");
  });
});
