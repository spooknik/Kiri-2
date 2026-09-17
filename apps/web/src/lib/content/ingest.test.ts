import { describe, expect, it } from "vitest";
import { compareChapterOrder, sortChapterRows, type OrderableChapter } from "./ingest";

function chapter(
  slug: string,
  number: number | null,
  createdAt = "2024-01-01T00:00:00.000Z",
): OrderableChapter {
  return { slug, number, createdAt: new Date(createdAt) };
}

describe("sortChapterRows", () => {
  it("orders by chapter number ascending, fractional numbers in place", () => {
    const ordered = sortChapterRows([
      chapter("c13", 13),
      chapter("c12-5", 12.5),
      chapter("c2", 2),
      chapter("c0", 0),
    ]);
    expect(ordered.map((row) => row.slug)).toEqual(["c0", "c2", "c12-5", "c13"]);
  });

  it("puts unnumbered chapters last (NULLS LAST), in discovery order", () => {
    const ordered = sortChapterRows([
      chapter("extra-b", null, "2024-02-02T00:00:00.000Z"),
      chapter("c1", 1),
      chapter("extra-a", null, "2024-02-01T00:00:00.000Z"),
      chapter("c2", 2),
    ]);
    expect(ordered.map((row) => row.slug)).toEqual(["c1", "c2", "extra-a", "extra-b"]);
  });

  it("breaks ties on createdAt, then on slug", () => {
    const ordered = sortChapterRows([
      chapter("b", 5, "2024-03-01T00:00:00.000Z"),
      chapter("a", 5, "2024-03-01T00:00:00.000Z"),
      chapter("earlier", 5, "2024-01-01T00:00:00.000Z"),
    ]);
    expect(ordered.map((row) => row.slug)).toEqual(["earlier", "a", "b"]);
  });

  it("does not mutate its input", () => {
    const rows = [chapter("c2", 2), chapter("c1", 1)];
    sortChapterRows(rows);
    expect(rows.map((row) => row.slug)).toEqual(["c2", "c1"]);
  });

  it("is a total order (0 only for identical rows)", () => {
    const a = chapter("same", 1);
    expect(compareChapterOrder(a, { ...a })).toBe(0);
    expect(compareChapterOrder(chapter("a", null), chapter("b", 9))).toBeGreaterThan(0);
    expect(compareChapterOrder(chapter("a", 9), chapter("b", null))).toBeLessThan(0);
    expect(compareChapterOrder(chapter("a", null), chapter("b", null))).toBeLessThan(0);
  });
});
