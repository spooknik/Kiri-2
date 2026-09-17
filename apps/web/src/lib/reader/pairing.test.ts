import { describe, expect, it } from "vitest";
import { buildSpreads, singleSpreads, spreadIndexForPage } from "./pairing";

/** Stand-ins for PageView; only identity matters to the pairing logic. */
function pages(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `p${index}`);
}

describe("buildSpreads", () => {
  it("returns nothing for an empty chapter", () => {
    expect(buildSpreads([], { coverFirst: true, direction: "ltr" })).toEqual([]);
  });

  it("shows the cover alone, then pairs, with an even page count", () => {
    const spreads = buildSpreads(pages(6), { coverFirst: true, direction: "ltr" });
    expect(spreads.map((spread) => spread.pageIndexes)).toEqual([[0], [1, 2], [3, 4], [5]]);
  });

  it("shows the cover alone, then pairs, with an odd page count", () => {
    const spreads = buildSpreads(pages(7), { coverFirst: true, direction: "ltr" });
    expect(spreads.map((spread) => spread.pageIndexes)).toEqual([[0], [1, 2], [3, 4], [5, 6]]);
  });

  it("pairs from the first page when cover-first is off", () => {
    expect(
      buildSpreads(pages(5), { coverFirst: false, direction: "ltr" }).map((s) => s.pageIndexes),
    ).toEqual([[0, 1], [2, 3], [4]]);
  });

  it("covers every page exactly once", () => {
    for (const count of [1, 2, 3, 8, 9]) {
      for (const coverFirst of [true, false]) {
        const flat = buildSpreads(pages(count), { coverFirst, direction: "ltr" }).flatMap(
          (spread) => spread.pageIndexes,
        );
        expect(flat).toEqual(Array.from({ length: count }, (_, index) => index));
      }
    }
  });

  it("mirrors the visual order in rtl but keeps reading order in pageIndexes", () => {
    const spreads = buildSpreads(pages(5), { coverFirst: false, direction: "rtl" });
    expect(spreads[0]?.items).toEqual(["p1", "p0"]);
    expect(spreads[0]?.pageIndexes).toEqual([0, 1]);
    expect(spreads[0]?.firstPageIndex).toBe(0);
    // A lone page has nothing to mirror.
    expect(spreads[2]?.items).toEqual(["p4"]);
  });

  it("leaves ltr spreads in source order", () => {
    const spreads = buildSpreads(pages(4), { coverFirst: false, direction: "ltr" });
    expect(spreads[0]?.items).toEqual(["p0", "p1"]);
  });
});

describe("singleSpreads", () => {
  it("gives every page its own spread", () => {
    expect(singleSpreads(pages(3)).map((spread) => spread.pageIndexes)).toEqual([[0], [1], [2]]);
  });
});

describe("spreadIndexForPage", () => {
  const spreads = buildSpreads(pages(7), { coverFirst: true, direction: "rtl" });

  it("finds the spread a page belongs to", () => {
    expect(spreadIndexForPage(spreads, 0)).toBe(0);
    expect(spreadIndexForPage(spreads, 2)).toBe(1);
    expect(spreadIndexForPage(spreads, 6)).toBe(3);
  });

  it("falls back to the first spread for an unknown page", () => {
    expect(spreadIndexForPage(spreads, 99)).toBe(0);
    expect(spreadIndexForPage([], 3)).toBe(0);
  });
});
