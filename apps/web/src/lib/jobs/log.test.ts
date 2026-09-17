/** Job output log: tail capping, line normalisation and flush bookkeeping. */
import { describe, expect, it } from "vitest";
import {
  JobLogBuffer,
  MAX_LOG_LINE_LENGTH,
  MAX_OUTPUT_LOG_LENGTH,
  normalizeLogLine,
  trimOutputLog,
} from "@/lib/jobs/log";

describe("trimOutputLog", () => {
  it("leaves short logs untouched", () => {
    expect(trimOutputLog("hello")).toBe("hello");
  });

  it("keeps the tail, not the head, once over the cap", () => {
    const long = "a".repeat(MAX_OUTPUT_LOG_LENGTH) + "TAIL";
    const trimmed = trimOutputLog(long);
    expect(trimmed).toHaveLength(MAX_OUTPUT_LOG_LENGTH);
    expect(trimmed.endsWith("TAIL")).toBe(true);
  });
});

describe("normalizeLogLine", () => {
  it("flattens newlines so one entry stays one line", () => {
    expect(normalizeLogLine("a\r\nb\nc")).toBe("a ⏎ b ⏎ c");
  });

  it("clips a very long line", () => {
    const line = normalizeLogLine("x".repeat(MAX_LOG_LINE_LENGTH * 2));
    expect(line.length).toBeLessThan(MAX_LOG_LINE_LENGTH + 40);
    expect(line.endsWith("(line truncated)")).toBe(true);
  });
});

describe("JobLogBuffer", () => {
  it("timestamps each line and returns it exactly once", () => {
    const buffer = new JobLogBuffer();
    expect(buffer.take()).toBeNull();

    buffer.append("first", new Date("2026-01-01T00:00:00.000Z"));
    const text = buffer.take();
    expect(text).toBe("[2026-01-01T00:00:00.000Z] first");
    expect(buffer.take()).toBeNull();
    // The value stays readable after a flush; only the dirty flag resets.
    expect(buffer.value).toBe(text);
  });

  it("accumulates lines and reports pending writes", () => {
    const buffer = new JobLogBuffer();
    buffer.append("one");
    buffer.append("two");
    expect(buffer.hasPendingWrite).toBe(true);
    expect(buffer.value.split("\n")).toHaveLength(2);
  });

  it("never grows past the cap however much is appended", () => {
    const buffer = new JobLogBuffer();
    // Lines are clipped first, so it takes ~80 of these to fill the cap.
    const chunk = "y".repeat(3_000);
    for (let i = 0; i < 200; i += 1) buffer.append(chunk);
    expect(buffer.value.length).toBe(MAX_OUTPUT_LOG_LENGTH);
    // Whatever survived is the most recent output.
    expect(buffer.value.endsWith("y")).toBe(true);
  });

  it("seeds from an existing log, trimmed", () => {
    const buffer = new JobLogBuffer("z".repeat(MAX_OUTPUT_LOG_LENGTH + 500));
    expect(buffer.value).toHaveLength(MAX_OUTPUT_LOG_LENGTH);
    expect(buffer.hasPendingWrite).toBe(false);
  });
});
