import { describe, expect, it } from "vitest";
import { isHttpUrl, normalizeTags, sanitizePathSegment, toSortTitle, truncate } from "@/lib/text";

describe("toSortTitle", () => {
  it("lowercases, de-accents and collapses whitespace", () => {
    expect(toSortTitle("  Sōsō   no   FRIEREN ")).toBe("soso no frieren");
    expect(toSortTitle("Ápice")).toBe("apice");
  });

  it("strips a leading article", () => {
    expect(toSortTitle("The Beginning After The End")).toBe("beginning after the end");
    expect(toSortTitle("A Returner's Magic Should Be Special")).toBe(
      "returner's magic should be special",
    );
    expect(toSortTitle("An Ordinary Day")).toBe("ordinary day");
  });

  it("does not strip an article that is part of a word", () => {
    expect(toSortTitle("Theft of Fire")).toBe("theft of fire");
    expect(toSortTitle("Anno Dracula")).toBe("anno dracula");
  });

  it("keeps the title when stripping would empty it", () => {
    expect(toSortTitle("The")).toBe("the");
    expect(toSortTitle("A ")).toBe("a");
  });

  it("is stable for titles that are already sort keys", () => {
    expect(toSortTitle("berserk")).toBe("berserk");
  });
});

describe("sanitizePathSegment", () => {
  it("replaces characters that filesystems reject", () => {
    expect(sanitizePathSegment("Re:Zero <kara>/hajimeru?")).toBe("Re_Zero _kara__hajimeru_");
    expect(sanitizePathSegment("a\\b|c*d")).toBe("a_b_c_d");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizePathSegment("  Chapter 1  ")).toBe("Chapter 1");
  });

  it("refuses traversal and empty segments", () => {
    expect(sanitizePathSegment(".")).toBe("_");
    expect(sanitizePathSegment("..")).toBe("_");
    expect(sanitizePathSegment("   ")).toBe("_");
    expect(sanitizePathSegment("")).toBe("_");
  });

  it("strips control characters", () => {
    const withControls = `nul${String.fromCharCode(0)}byte${String.fromCharCode(31)}`;
    expect(sanitizePathSegment(withControls)).toBe("nul_byte_");
  });

  it("leaves ordinary names alone", () => {
    expect(sanitizePathSegment("Chapter 12.5 - The End")).toBe("Chapter 12.5 - The End");
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https only", () => {
    expect(isHttpUrl("https://example.com/manga/1")).toBe(true);
    expect(isHttpUrl("http://localhost:3000")).toBe(true);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/plain,hi")).toBe(false);
    expect(isHttpUrl("/relative/path")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(42)).toBe(false);
  });
});

describe("normalizeTags", () => {
  it("trims, drops empties and de-duplicates case-insensitively", () => {
    expect(normalizeTags([" Action ", "action", "ACTION", "", "  ", "Drama"])).toEqual([
      "Action",
      "Drama",
    ]);
  });

  it("ignores non-strings and non-arrays", () => {
    expect(normalizeTags(["ok", 1, null, undefined, { a: 1 }, ["nested"]])).toEqual(["ok"]);
    expect(normalizeTags("action")).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it("caps tag length at 40 characters", () => {
    const long = "x".repeat(60);
    expect(normalizeTags([long])).toEqual(["x".repeat(40)]);
  });

  it("caps the list at 30 tags", () => {
    const many = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
    expect(normalizeTags(many)).toHaveLength(30);
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("exact", 5)).toBe("exact");
  });

  it("clips longer text to max characters including the ellipsis", () => {
    const out = truncate("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out).toHaveLength(5);
  });

  it("does not leave a dangling space before the ellipsis", () => {
    expect(truncate("hello world", 7)).toBe("hello…");
  });

  it("returns an empty string for a non-positive max", () => {
    expect(truncate("anything", 0)).toBe("");
  });
});
