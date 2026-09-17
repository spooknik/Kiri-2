/**
 * Pure geometry for the vertical strip: how tall each page will be, where it
 * sits in the scroll container, which pages are worth mounting, and which page
 * the reader is actually looking at.
 *
 * Keeping this side-effect free is what makes the strip virtualisable without
 * scroll jumps: the layout is computed from the page dimensions the API
 * returns, so an unmounted page reserves exactly the space it will occupy once
 * it mounts.
 */
import type { ReaderFit } from "./prefs";

/** Aspect ratio (width / height) assumed when the API has no dimensions. */
export const FALLBACK_ASPECT = 0.7;

/**
 * Widest a single page column gets in fit-width mode.
 *
 * Without a cap, "fit width" on a 27" monitor blows a 900px scan up to 2000px
 * and the reader gets a blurry upscale of a page nobody wanted that big. Phone
 * and tablet widths are all below the cap, so it only ever bites on desktop.
 * Fit-original is deliberately exempt: it means "the size it really is".
 */
export const MAX_PAGE_COLUMN_WIDTH = 1000;

export interface PageDimensions {
  width: number | null;
  height: number | null;
}

export function pageAspect(page: PageDimensions): number {
  const { width, height } = page;
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    return width / height;
  }
  return FALLBACK_ASPECT;
}

export interface StripLayout {
  /** Rendered width of each page, in CSS pixels. */
  widths: number[];
  /** Rendered height of each page, in CSS pixels. */
  heights: number[];
  /** Distance from the top of the scroll content to the top of each page. */
  offsets: number[];
  /** Total scrollable height of all pages plus gaps. */
  total: number;
}

/**
 * Lays out the strip. `containerWidth` is the width available for images;
 * `viewportHeight` only matters for `fit: "height"`, which caps a page so a
 * single page never exceeds one screen.
 */
export function computeStripLayout(
  pages: readonly PageDimensions[],
  containerWidth: number,
  viewportHeight: number,
  fit: ReaderFit,
  gap = 0,
  maxColumnWidth = MAX_PAGE_COLUMN_WIDTH,
): StripLayout {
  const widths: number[] = [];
  const heights: number[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  const safeWidth = containerWidth > 0 ? containerWidth : 0;
  const columnWidth = Math.min(safeWidth, Math.max(0, maxColumnWidth));

  for (const page of pages) {
    const aspect = pageAspect(page);
    let width: number;
    if (fit === "original" && typeof page.width === "number" && page.width > 0) {
      width = Math.min(page.width, safeWidth);
    } else if (fit === "height" && viewportHeight > 0) {
      width = Math.min(safeWidth, viewportHeight * aspect);
    } else {
      width = columnWidth;
    }
    const height = aspect > 0 ? width / aspect : 0;
    widths.push(width);
    heights.push(height);
    offsets.push(cursor);
    cursor += height + gap;
  }

  return { widths, heights, offsets, total: Math.max(0, cursor - (pages.length > 0 ? gap : 0)) };
}

export interface PageRect {
  index: number;
  /** Top edge relative to the top of the viewport (like a DOMRect). */
  top: number;
  height: number;
}

/**
 * The page occupying the most of the viewport, ties broken by the page whose
 * centre is nearest the viewport centre. Ported from Kiri v1
 * (`src/components/reader-client.tsx`, `getMostVisiblePageIndex`).
 */
export function mostVisiblePageIndex(
  rects: readonly PageRect[],
  viewportHeight: number,
  fallbackIndex: number,
): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return fallbackIndex;

  const viewportCenter = viewportHeight / 2;
  let bestIndex = fallbackIndex;
  let bestVisibleHeight = 0;
  let bestCenterDistance = Number.POSITIVE_INFINITY;

  for (const rect of rects) {
    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.top + rect.height, viewportHeight);
    const visibleHeight = visibleBottom - visibleTop;
    if (visibleHeight <= 0) continue;

    const centerDistance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
    if (
      visibleHeight > bestVisibleHeight ||
      (visibleHeight === bestVisibleHeight && centerDistance < bestCenterDistance)
    ) {
      bestIndex = rect.index;
      bestVisibleHeight = visibleHeight;
      bestCenterDistance = centerDistance;
    }
  }

  return bestIndex;
}

/** Turns a strip layout plus a scroll offset into viewport-relative rects. */
export function stripRects(layout: StripLayout, scrollTop: number): PageRect[] {
  return layout.offsets.map((offset, index) => ({
    index,
    top: offset - scrollTop,
    height: layout.heights[index] ?? 0,
  }));
}

/** Half-open `[start, end)` range of pages to mount. */
export interface VisibleRange {
  start: number;
  end: number;
}

/**
 * Pages intersecting the viewport expanded by `overscanViewports` screens in
 * each direction. Never returns an empty range for a non-empty strip: if the
 * scroll offset is out of bounds (a resize mid-scroll) it falls back to the
 * nearest page, so something is always on screen.
 */
export function computeVisibleRange(
  layout: StripLayout,
  scrollTop: number,
  viewportHeight: number,
  overscanViewports = 2,
): VisibleRange {
  const count = layout.heights.length;
  if (count === 0) return { start: 0, end: 0 };

  const overscan = Math.max(0, viewportHeight) * Math.max(0, overscanViewports);
  const min = scrollTop - overscan;
  const max = scrollTop + Math.max(0, viewportHeight) + overscan;

  let start = -1;
  let end = 0;
  for (let index = 0; index < count; index += 1) {
    const top = layout.offsets[index] ?? 0;
    const bottom = top + (layout.heights[index] ?? 0);
    if (bottom < min || top > max) continue;
    if (start === -1) start = index;
    end = index + 1;
  }

  if (start === -1) {
    const nearest = scrollTop <= 0 ? 0 : count - 1;
    return { start: nearest, end: nearest + 1 };
  }
  return { start, end };
}
