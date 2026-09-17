import { describe, expect, it } from "vitest";
import {
  AUTO_SYNC_INTERVAL_PRESETS,
  DEFAULT_CUSTOM_INTERVAL_MINUTES,
  nearestPresetMinutes,
} from "./auto-sync-options";

describe("nearestPresetMinutes", () => {
  it("falls back to the 24h default for null/undefined", () => {
    expect(nearestPresetMinutes(null)).toBe(DEFAULT_CUSTOM_INTERVAL_MINUTES);
    expect(nearestPresetMinutes(undefined)).toBe(DEFAULT_CUSTOM_INTERVAL_MINUTES);
  });

  it("falls back to the default for a non-finite value", () => {
    expect(nearestPresetMinutes(Number.NaN)).toBe(DEFAULT_CUSTOM_INTERVAL_MINUTES);
  });

  it("returns the exact preset when the value matches one", () => {
    for (const preset of AUTO_SYNC_INTERVAL_PRESETS) {
      expect(nearestPresetMinutes(preset.minutes)).toBe(preset.minutes);
    }
  });

  it("snaps to the closest preset for an in-between value", () => {
    // Between 6h (360) and 12h (720), closer to 6h.
    expect(nearestPresetMinutes(400)).toBe(360);
    // Between 12h (720) and 24h (1440), closer to 24h.
    expect(nearestPresetMinutes(1300)).toBe(1440);
  });

  it("clamps an extreme value to the nearest end preset", () => {
    expect(nearestPresetMinutes(1)).toBe(360);
    expect(nearestPresetMinutes(100_000)).toBe(7 * 24 * 60);
  });

  it("every preset falls inside the schema's allowed range [60, 43200]", () => {
    for (const preset of AUTO_SYNC_INTERVAL_PRESETS) {
      expect(preset.minutes).toBeGreaterThanOrEqual(60);
      expect(preset.minutes).toBeLessThanOrEqual(43_200);
    }
  });
});
