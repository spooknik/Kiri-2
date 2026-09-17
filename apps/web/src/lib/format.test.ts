import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatBytes, formatRelativeTime } from "./format";

describe("formatBytes", () => {
  it("formats zero and negative/invalid input as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });

  it("returns 'Just now' for sub-minute deltas", () => {
    expect(formatRelativeTime(new Date("2026-01-10T11:59:30.000Z"))).toBe("Just now");
  });

  it("formats minutes", () => {
    expect(formatRelativeTime(new Date("2026-01-10T11:45:00.000Z"))).toBe("15m ago");
  });

  it("formats hours", () => {
    expect(formatRelativeTime(new Date("2026-01-10T09:00:00.000Z"))).toBe("3h ago");
  });

  it("formats days", () => {
    expect(formatRelativeTime(new Date("2026-01-07T12:00:00.000Z"))).toBe("3d ago");
  });

  it("falls back to a locale date string past a week", () => {
    const target = new Date("2025-12-20T12:00:00.000Z");
    expect(formatRelativeTime(target)).toBe(target.toLocaleDateString());
  });

  it("accepts a string input", () => {
    expect(formatRelativeTime("2026-01-10T11:59:30.000Z")).toBe("Just now");
  });
});
