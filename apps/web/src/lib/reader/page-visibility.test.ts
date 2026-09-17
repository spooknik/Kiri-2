import { describe, expect, it } from "vitest";
import {
  computeStripLayout,
  computeVisibleRange,
  FALLBACK_ASPECT,
  mostVisiblePageIndex,
  pageAspect,
  stripRects,
  type PageRect,
} from "./page-visibility";

describe("pageAspect", () => {
  it("uses the real dimensions when the API has them", () => {
    expect(pageAspect({ width: 800, height: 1200 })).toBeCloseTo(800 / 1200);
  });

  it("falls back for missing or nonsense dimensions", () => {
    expect(pageAspect({ width: null, height: null })).toBe(FALLBACK_ASPECT);
    expect(pageAspect({ width: 0, height: 100 })).toBe(FALLBACK_ASPECT);
    expect(pageAspect({ width: 100, height: null })).toBe(FALLBACK_ASPECT);
  });
});

describe("computeStripLayout", () => {
  const pages = [
    { width: 800, height: 1600 }, // aspect 0.5
    { width: 800, height: 800 }, // aspect 1
    { width: null, height: null }, // fallback 0.7
  ];

  it("caps the fit-width column so a wide screen never upscales a page", () => {
    const layout = computeStripLayout(pages, 2400, 900, "width");
    expect(layout.widths).toEqual([1000, 1000, 1000]);
    // fit-original is exempt: it means the size the page really is.
    expect(
      computeStripLayout([{ width: 1600, height: 2400 }], 2400, 900, "original").widths,
    ).toEqual([1600]);
  });

  it("fills the container width and derives height from the aspect", () => {
    const layout = computeStripLayout(pages, 400, 900, "width");
    expect(layout.widths).toEqual([400, 400, 400]);
    expect(layout.heights[0]).toBe(800);
    expect(layout.heights[1]).toBe(400);
    expect(layout.heights[2]).toBeCloseTo(400 / FALLBACK_ASPECT);
  });

  it("stacks offsets so nothing overlaps and the total matches", () => {
    const layout = computeStripLayout(pages, 400, 900, "width");
    expect(layout.offsets[0]).toBe(0);
    expect(layout.offsets[1]).toBe(layout.heights[0]);
    expect(layout.offsets[2]).toBe((layout.heights[0] ?? 0) + (layout.heights[1] ?? 0));
    expect(layout.total).toBeCloseTo(layout.heights.reduce((sum, h) => sum + h, 0));
  });

  it("caps a page to one screen in fit-height", () => {
    const layout = computeStripLayout(pages, 400, 300, "height");
    // aspect 0.5 at 300px tall is 150px wide, narrower than the container.
    expect(layout.widths[0]).toBe(150);
    expect(layout.heights[0]).toBe(300);
  });

  it("never upscales past the natural width in fit-original", () => {
    const layout = computeStripLayout([{ width: 200, height: 400 }], 400, 900, "original");
    expect(layout.widths[0]).toBe(200);
    expect(layout.heights[0]).toBe(400);
  });

  it("handles an empty chapter and a zero-width container", () => {
    expect(computeStripLayout([], 400, 900, "width")).toEqual({
      widths: [],
      heights: [],
      offsets: [],
      total: 0,
    });
    expect(computeStripLayout(pages, 0, 0, "width").total).toBe(0);
  });
});

describe("mostVisiblePageIndex", () => {
  const viewportHeight = 1000;

  it("picks the page filling most of the viewport", () => {
    const rects: PageRect[] = [
      { index: 0, top: -700, height: 800 }, // 100px visible
      { index: 1, top: 100, height: 800 }, // 800px visible
      { index: 2, top: 900, height: 800 }, // 100px visible
    ];
    expect(mostVisiblePageIndex(rects, viewportHeight, 0)).toBe(1);
  });

  it("breaks a tie by distance from the viewport centre", () => {
    const rects: PageRect[] = [
      { index: 0, top: -100, height: 200 }, // 100px visible, centre far up
      { index: 1, top: 450, height: 100 }, // 100px visible, centred
    ];
    expect(mostVisiblePageIndex(rects, viewportHeight, 0)).toBe(1);
  });

  it("returns the fallback when nothing is on screen", () => {
    const rects: PageRect[] = [{ index: 5, top: 2000, height: 400 }];
    expect(mostVisiblePageIndex(rects, viewportHeight, 3)).toBe(3);
    expect(mostVisiblePageIndex([], viewportHeight, 7)).toBe(7);
  });

  it("returns the fallback for a viewport it can't measure", () => {
    const rects: PageRect[] = [{ index: 1, top: 0, height: 100 }];
    expect(mostVisiblePageIndex(rects, 0, 4)).toBe(4);
    expect(mostVisiblePageIndex(rects, Number.NaN, 4)).toBe(4);
  });

  it("prefers a tall page over a page merely nearer the centre", () => {
    const rects: PageRect[] = [
      { index: 0, top: 0, height: 900 },
      { index: 1, top: 900, height: 400 },
    ];
    expect(mostVisiblePageIndex(rects, viewportHeight, 1)).toBe(0);
  });
});

describe("computeVisibleRange", () => {
  // 10 pages, 100px each.
  const layout = computeStripLayout(
    Array.from({ length: 10 }, () => ({ width: 100, height: 100 })),
    100,
    100,
    "width",
  );

  it("mounts the viewport plus two screens either side", () => {
    // Viewport 100px at scrollTop 500, two screens either side -> [300, 800],
    // which pages 2..8 touch.
    expect(computeVisibleRange(layout, 500, 100)).toEqual({ start: 2, end: 9 });
  });

  it("clips at the start of the strip", () => {
    // [-200, 300] -> pages 0..3.
    expect(computeVisibleRange(layout, 0, 100)).toEqual({ start: 0, end: 4 });
  });

  it("honours a custom overscan", () => {
    // No overscan: only the pages the viewport [500, 600] actually touches.
    expect(computeVisibleRange(layout, 500, 100, 0)).toEqual({ start: 4, end: 7 });
  });

  it("is empty only for an empty strip", () => {
    expect(computeVisibleRange(computeStripLayout([], 100, 100, "width"), 0, 100)).toEqual({
      start: 0,
      end: 0,
    });
  });

  it("falls back to the nearest page when scrolled out of bounds", () => {
    expect(computeVisibleRange(layout, 99999, 100)).toEqual({ start: 9, end: 10 });
    expect(computeVisibleRange(layout, -99999, 100)).toEqual({ start: 0, end: 1 });
  });
});

describe("stripRects", () => {
  it("turns offsets into viewport-relative rects", () => {
    const layout = computeStripLayout(
      [
        { width: 100, height: 100 },
        { width: 100, height: 100 },
      ],
      100,
      100,
      "width",
    );
    expect(stripRects(layout, 50)).toEqual([
      { index: 0, top: -50, height: 100 },
      { index: 1, top: 50, height: 100 },
    ]);
  });
});
