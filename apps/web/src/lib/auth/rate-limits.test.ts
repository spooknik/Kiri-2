import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { resetRateLimits } from "@/lib/rate-limit";
import { AUTH_RATE_LIMITS, clientKey, limitAuthAttempt, retryAfterSeconds } from "./rate-limits";

/** A clock the tests advance by hand, so refills are deterministic. */
function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

const savedEnv = { ...process.env };

beforeEach(() => {
  resetRateLimits();
  delete process.env.AUTH_TRUST_PROXY;
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...savedEnv };
  resetEnvCache();
  resetRateLimits();
});

describe("clientKey", () => {
  it("ignores proxy headers when AUTH_TRUST_PROXY is not 1", () => {
    // Without a trusted proxy in front, these headers are attacker-controlled:
    // honouring them would hand every request its own bucket.
    expect(clientKey(headers({ "x-forwarded-for": "1.2.3.4" }))).toBe("direct");
    expect(clientKey(headers({ "cf-connecting-ip": "1.2.3.4" }))).toBe("direct");
    expect(clientKey(null)).toBe("direct");
  });

  it("prefers cf-connecting-ip when the proxy is trusted", () => {
    process.env.AUTH_TRUST_PROXY = "1";
    resetEnvCache();

    expect(
      clientKey(headers({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" })),
    ).toBe("9.9.9.9");
  });

  it("falls back to the first x-forwarded-for entry when the proxy is trusted", () => {
    process.env.AUTH_TRUST_PROXY = "1";
    resetEnvCache();

    expect(clientKey(headers({ "x-forwarded-for": " 1.1.1.1 , 2.2.2.2 " }))).toBe("1.1.1.1");
    expect(clientKey(headers({ "x-forwarded-for": "  " }))).toBe("direct");
    expect(clientKey(headers({}))).toBe("direct");
    expect(clientKey(null)).toBe("direct");
  });
});

describe("limitAuthAttempt", () => {
  it("allows the identity bucket's capacity and then denies", () => {
    const clock = fakeClock();
    const attempt = () =>
      limitAuthAttempt({ scope: "/sign-in/email", email: "a@b.c", now: clock.now });

    for (let i = 0; i < AUTH_RATE_LIMITS.identity.capacity; i += 1) {
      expect(attempt().allowed).toBe(true);
    }

    const denied = attempt();
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("keys the identity bucket case-insensitively", () => {
    const clock = fakeClock();
    for (let i = 0; i < AUTH_RATE_LIMITS.identity.capacity; i += 1) {
      limitAuthAttempt({ scope: "/sign-in/email", email: "Victim@Example.com", now: clock.now });
    }

    expect(
      limitAuthAttempt({ scope: "/sign-in/email", email: "victim@example.com", now: clock.now })
        .allowed,
    ).toBe(false);
  });

  it("does not let one exhausted identity block another", () => {
    const clock = fakeClock();
    for (let i = 0; i < AUTH_RATE_LIMITS.identity.capacity + 3; i += 1) {
      limitAuthAttempt({ scope: "/sign-in/email", email: "victim@example.com", now: clock.now });
    }

    expect(
      limitAuthAttempt({ scope: "/sign-in/email", email: "other@example.com", now: clock.now })
        .allowed,
    ).toBe(true);
  });

  it("scopes the identity bucket per endpoint", () => {
    const clock = fakeClock();
    for (let i = 0; i < AUTH_RATE_LIMITS.identity.capacity; i += 1) {
      limitAuthAttempt({ scope: "/sign-in/email", email: "a@b.c", now: clock.now });
    }

    expect(
      limitAuthAttempt({ scope: "/sign-up/email", email: "a@b.c", now: clock.now }).allowed,
    ).toBe(true);
  });

  it("refills the identity bucket over time", () => {
    const clock = fakeClock();
    for (let i = 0; i < AUTH_RATE_LIMITS.identity.capacity; i += 1) {
      limitAuthAttempt({ scope: "/sign-in/email", email: "a@b.c", now: clock.now });
    }
    expect(
      limitAuthAttempt({ scope: "/sign-in/email", email: "a@b.c", now: clock.now }).allowed,
    ).toBe(false);

    // One token per 30 s.
    clock.advance(30_000);
    expect(
      limitAuthAttempt({ scope: "/sign-in/email", email: "a@b.c", now: clock.now }).allowed,
    ).toBe(true);
    expect(
      limitAuthAttempt({ scope: "/sign-in/email", email: "a@b.c", now: clock.now }).allowed,
    ).toBe(false);
  });

  it("stops one client spraying many identities", () => {
    const clock = fakeClock();
    let allowed = 0;
    for (let i = 0; i < AUTH_RATE_LIMITS.client.capacity + 5; i += 1) {
      const result = limitAuthAttempt({
        scope: "/sign-in/email",
        email: `user${i}@example.com`,
        now: clock.now,
      });
      if (result.allowed) allowed += 1;
    }

    expect(allowed).toBe(AUTH_RATE_LIMITS.client.capacity);
  });

  it("separates clients once the proxy is trusted", () => {
    process.env.AUTH_TRUST_PROXY = "1";
    resetEnvCache();
    const clock = fakeClock();

    for (let i = 0; i < AUTH_RATE_LIMITS.client.capacity; i += 1) {
      limitAuthAttempt({
        scope: "/sign-in/email",
        email: `user${i}@example.com`,
        headers: headers({ "cf-connecting-ip": "1.1.1.1" }),
        now: clock.now,
      });
    }

    expect(
      limitAuthAttempt({
        scope: "/sign-in/email",
        email: "late@example.com",
        headers: headers({ "cf-connecting-ip": "1.1.1.1" }),
        now: clock.now,
      }).allowed,
    ).toBe(false);
    expect(
      limitAuthAttempt({
        scope: "/sign-in/email",
        email: "late@example.com",
        headers: headers({ "cf-connecting-ip": "2.2.2.2" }),
        now: clock.now,
      }).allowed,
    ).toBe(true);
  });

  it("limits by subject when there is no email", () => {
    const clock = fakeClock();
    for (let i = 0; i < AUTH_RATE_LIMITS.identity.capacity; i += 1) {
      expect(
        limitAuthAttempt({ scope: "/claim-invite", subject: "token-hash", now: clock.now }).allowed,
      ).toBe(true);
    }

    expect(
      limitAuthAttempt({ scope: "/claim-invite", subject: "token-hash", now: clock.now }).allowed,
    ).toBe(false);
    expect(
      limitAuthAttempt({ scope: "/claim-invite", subject: "other-hash", now: clock.now }).allowed,
    ).toBe(true);
  });

  it("still consumes the client bucket when no identity is known", () => {
    const clock = fakeClock();
    let allowed = 0;
    for (let i = 0; i < AUTH_RATE_LIMITS.client.capacity + 2; i += 1) {
      if (limitAuthAttempt({ scope: "/change-password", now: clock.now }).allowed) allowed += 1;
    }

    expect(allowed).toBe(AUTH_RATE_LIMITS.client.capacity);
  });

  it("reports the longest wait of the buckets that denied", () => {
    const clock = fakeClock();
    for (let i = 0; i < AUTH_RATE_LIMITS.identity.capacity + 1; i += 1) {
      limitAuthAttempt({ scope: "/sign-in/email", email: "a@b.c", now: clock.now });
    }

    const denied = limitAuthAttempt({ scope: "/sign-in/email", email: "a@b.c", now: clock.now });
    expect(denied.allowed).toBe(false);
    // The identity bucket refills at 1 per 30 s, so the wait is on that scale.
    expect(denied.retryAfterMs).toBeGreaterThan(10_000);
    expect(retryAfterSeconds(denied.retryAfterMs)).toBeGreaterThanOrEqual(1);
  });
});

describe("retryAfterSeconds", () => {
  it("rounds up, never below one second, and copes with Infinity", () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1500)).toBe(2);
    expect(retryAfterSeconds(Number.POSITIVE_INFINITY)).toBe(60);
  });
});
