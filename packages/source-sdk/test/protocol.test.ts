import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAPTER_STATUSES,
  emit,
  ERROR_CODES,
  EXIT_CODES,
  formatEventLine,
  MAX_MESSAGE_LENGTH,
  parseEventLine,
  parseEventLines,
  PROTOCOL_VERSION,
  type PluginEvent,
} from "../src/protocol.js";
import { SDK_VERSION } from "../src/version.js";

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emit", () => {
  it("writes exactly one JSON line per event", () => {
    const { lines, restore } = captureStdout();
    emit({ t: "hello", v: PROTOCOL_VERSION, plugin: "demo", version: "1.0.0", sdk: SDK_VERSION });
    emit({ t: "progress", phase: "page", current: 2, total: 3, chapterSlug: "ch-1" });
    restore();

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.trimEnd().includes("\n")).toBe(false);
    }
    expect(JSON.parse(lines[0] as string)).toMatchObject({ t: "hello", v: 1, plugin: "demo" });
  });

  it("keeps a multi-line message on one line", () => {
    const { lines, restore } = captureStdout();
    emit({ t: "log", level: "warn", msg: "first\nsecond" });
    restore();
    expect(lines[0]).toBe('{"t":"log","level":"warn","msg":"first\\nsecond"}\n');
    expect(parseEventLine(lines[0] as string)).toEqual({
      t: "log",
      level: "warn",
      msg: "first\nsecond",
    });
  });

  it("truncates oversized messages", () => {
    const line = formatEventLine({
      t: "log",
      level: "info",
      msg: "x".repeat(MAX_MESSAGE_LENGTH + 500),
    });
    const event = parseEventLine(line);
    expect(event?.t).toBe("log");
    expect((event as { msg: string }).msg.length).toBeLessThan(MAX_MESSAGE_LENGTH + 50);
    expect((event as { msg: string }).msg.endsWith("(truncated)")).toBe(true);
  });
});

describe("parseEventLine", () => {
  it("round-trips every event type", () => {
    const events: PluginEvent[] = [
      { t: "hello", v: 1, plugin: "demo", version: "1.2.3", sdk: SDK_VERSION },
      { t: "log", level: "error", msg: "boom" },
      { t: "progress", phase: "chapter", current: 1, total: 4, chapterSlug: "c", bytes: 99 },
      { t: "chapter", slug: "c-1", title: "One", number: 1, pageCount: 12, status: "completed" },
      { t: "result", ok: true, data: { chapterCount: 3 } },
      {
        t: "error",
        ok: false,
        code: "RATE_LIMITED",
        message: "429",
        retryable: true,
        hint: "wait",
      },
    ];
    for (const event of events) {
      expect(parseEventLine(formatEventLine(event))).toEqual(event);
    }
  });

  it("returns null for anything that is not a protocol line", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("   ")).toBeNull();
    expect(parseEventLine("npm warn deprecated foo@1")).toBeNull();
    expect(parseEventLine("{not json")).toBeNull();
    expect(parseEventLine("[1,2,3]")).toBeNull();
    expect(parseEventLine('{"t":"unknown"}')).toBeNull();
    expect(parseEventLine('{"t":"hello"}')).toBeNull();
  });

  it("degrades unknown enum values instead of failing", () => {
    expect(parseEventLine('{"t":"log","level":"trace","msg":"hi"}')).toEqual({
      t: "log",
      level: "info",
      msg: "hi",
    });
    expect(parseEventLine('{"t":"error","code":"WAT","message":"x"}')).toEqual({
      t: "error",
      ok: false,
      code: "INTERNAL",
      message: "x",
      retryable: false,
    });
    expect(parseEventLine('{"t":"chapter","slug":"a"}')).toEqual({
      t: "chapter",
      slug: "a",
      title: "a",
      number: null,
      pageCount: 0,
      status: "pending",
    });
  });

  it("splits a stdout chunk into events and leftovers", () => {
    const text = [
      formatEventLine({ t: "log", level: "info", msg: "one" }).trimEnd(),
      "something a plugin printed by accident",
      formatEventLine({ t: "result", ok: true, data: 42 }).trimEnd(),
      "",
    ].join("\n");
    const { events, unparsed } = parseEventLines(text);
    expect(events.map((event) => event.t)).toEqual(["log", "result"]);
    expect(unparsed).toEqual(["something a plugin printed by accident"]);
  });
});

describe("constants", () => {
  it("keeps the closed sets the host relies on", () => {
    expect([...ERROR_CODES]).toEqual([
      "NEEDS_CREDENTIAL",
      "RATE_LIMITED",
      "NOT_FOUND",
      "UNSUPPORTED_URL",
      "BLOCKED",
      "NETWORK",
      "PARSE",
      "IO",
      "CANCELLED",
      "INTERNAL",
    ]);
    expect([...CHAPTER_STATUSES]).toEqual(["pending", "downloading", "completed", "failed"]);
    expect(EXIT_CODES).toEqual({
      OK: 0,
      INTERNAL: 1,
      USAGE: 2,
      NEEDS_CREDENTIAL: 3,
      NOT_FOUND: 4,
      RATE_LIMITED: 5,
      CANCELLED: 6,
      SDK_INCOMPATIBLE: 7,
    });
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("reports the package version as SDK_VERSION", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(path.join(here, "..", "package.json"), "utf8")) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
