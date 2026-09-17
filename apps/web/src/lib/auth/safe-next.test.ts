import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it.each([
    ["/", "/"],
    ["/series/1", "/series/1"],
    ["/series/1?tab=notes&page=2", "/series/1?tab=notes&page=2"],
    ["/read?series=abc#page-3", "/read?series=abc#page-3"],
    ["/admin/users", "/admin/users"],
  ])("keeps the same-origin path %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "//evil.example.com",
    "///evil.example.com",
    "/\\evil.example.com",
    "\\\\evil.example.com",
    "/path\\evil",
    "https://evil.example.com",
    "http://evil.example.com/x",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "mailto:a@b.c",
    "series/1",
    " /series/1",
    "/series 1",
  ])("rejects %s", (input) => {
    expect(safeNext(input)).toBe("/");
  });

  it("rejects control characters the URL parser would strip", () => {
    // "/\t/evil.example.com" parses as //evil.example.com once the tab is
    // dropped, so a naive `startsWith("//")` check misses it.
    expect(safeNext("/\t/evil.example.com")).toBe("/");
    expect(safeNext("/\n/evil.example.com")).toBe("/");
    expect(safeNext("/\r/evil.example.com")).toBe("/");
    expect(safeNext("/\t\\evil.example.com")).toBe("/");
    expect(safeNext("ht\ttps://evil.example.com")).toBe("/");
    expect(new URL("/\t/evil.example.com", "http://x").origin).toBe("http://evil.example.com");
  });

  it("does not treat a path that merely contains a colon as absolute", () => {
    expect(safeNext("/series/a:b")).toBe("/series/a:b");
  });

  it("rejects a non-string", () => {
    expect(safeNext(undefined)).toBe("/");
  });
});
