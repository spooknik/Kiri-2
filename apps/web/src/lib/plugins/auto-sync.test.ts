/**
 * Auto-sync due-ness and interval resolution.
 *
 * Pure functions on purpose: "is this source due?" is the rule most likely to
 * be changed by accident, and it should be provable without a database, a
 * timer or a job.
 */
import { describe, expect, it } from "vitest";
import { isDue, type DueInput } from "@/lib/plugins/auto-sync";
import { effectiveIntervalMinutes } from "@/lib/plugins/serialize";

const NOW = new Date("2026-03-01T12:00:00Z");
const DAY_MINUTES = 1440;

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60 * 1000);
}

/**
 * `createdAt` is the third term of the max, so it defaults to "long ago" here
 * and the tests that care about a fresh source set it explicitly.
 */
function source(overrides: Partial<DueInput> = {}): DueInput {
  return {
    lastSyncedAt: null,
    autoSyncRequestedAt: null,
    createdAt: minutesAgo(DAY_MINUTES * 40),
    autoSyncMode: "INHERIT",
    autoSyncIntervalMinutes: null,
    ...overrides,
  };
}

describe("effectiveIntervalMinutes", () => {
  it("follows the instance interval on INHERIT", () => {
    expect(effectiveIntervalMinutes("INHERIT", null, DAY_MINUTES, true)).toBe(DAY_MINUTES);
  });

  it("is null on INHERIT while auto-sync is globally off", () => {
    expect(effectiveIntervalMinutes("INHERIT", null, DAY_MINUTES, false)).toBeNull();
  });

  it("is always null on DISABLED", () => {
    expect(effectiveIntervalMinutes("DISABLED", 60, DAY_MINUTES, true)).toBeNull();
  });

  it("uses its own value on CUSTOM, falling back to the global one", () => {
    expect(effectiveIntervalMinutes("CUSTOM", 180, DAY_MINUTES, true)).toBe(180);
    expect(effectiveIntervalMinutes("CUSTOM", null, DAY_MINUTES, true)).toBe(DAY_MINUTES);
  });
});

describe("isDue", () => {
  it("is due when nothing has ever run and the source is older than the interval", () => {
    expect(isDue(source({ createdAt: minutesAgo(DAY_MINUTES + 1) }), DAY_MINUTES, true, NOW)).toBe(
      true,
    );
  });

  it("is not due immediately after the source is created", () => {
    expect(isDue(source({ createdAt: minutesAgo(5) }), DAY_MINUTES, true, NOW)).toBe(false);
  });

  it("counts from the last successful sync", () => {
    expect(
      isDue(source({ lastSyncedAt: minutesAgo(DAY_MINUTES + 5) }), DAY_MINUTES, true, NOW),
    ).toBe(true);
    expect(isDue(source({ lastSyncedAt: minutesAgo(60) }), DAY_MINUTES, true, NOW)).toBe(false);
  });

  it("counts from the last request too, so a failing series is not retried every sweep", () => {
    // V1's rule: lastSyncedAt alone would re-queue a permanently failing source
    // on every pass, because it never advances.
    const failing = source({
      lastSyncedAt: minutesAgo(DAY_MINUTES * 30),
      autoSyncRequestedAt: minutesAgo(30),
    });
    expect(isDue(failing, DAY_MINUTES, true, NOW)).toBe(false);

    const stale = source({
      lastSyncedAt: minutesAgo(DAY_MINUTES * 30),
      autoSyncRequestedAt: minutesAgo(DAY_MINUTES + 1),
    });
    expect(isDue(stale, DAY_MINUTES, true, NOW)).toBe(true);
  });

  it("honours a custom interval", () => {
    const custom = source({
      autoSyncMode: "CUSTOM",
      autoSyncIntervalMinutes: 60,
      lastSyncedAt: minutesAgo(90),
    });
    expect(isDue(custom, DAY_MINUTES, true, NOW)).toBe(true);
    expect(isDue({ ...custom, lastSyncedAt: minutesAgo(30) }, DAY_MINUTES, true, NOW)).toBe(false);
  });

  it("never runs a DISABLED source", () => {
    expect(
      isDue(
        source({ autoSyncMode: "DISABLED", lastSyncedAt: minutesAgo(DAY_MINUTES * 10) }),
        DAY_MINUTES,
        true,
        NOW,
      ),
    ).toBe(false);
  });

  it("never runs an INHERIT source while auto-sync is globally off", () => {
    expect(
      isDue(source({ lastSyncedAt: minutesAgo(DAY_MINUTES * 10) }), DAY_MINUTES, false, NOW),
    ).toBe(false);
  });

  it("is due exactly at the interval boundary", () => {
    expect(isDue(source({ lastSyncedAt: minutesAgo(DAY_MINUTES) }), DAY_MINUTES, true, NOW)).toBe(
      true,
    );
  });
});
