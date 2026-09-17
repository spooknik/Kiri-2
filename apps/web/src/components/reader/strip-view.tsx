"use client";

/**
 * Vertical continuous ("webtoon") reading mode.
 *
 * Virtualised: the strip's total height comes from the page dimensions the API
 * returns, every page is absolutely positioned at a precomputed offset, and
 * only pages within +/- 2 viewport heights of the scroll offset are mounted.
 * Because the reserved box is exactly the box the image will occupy, mounting
 * and unmounting never shifts the scroll offset.
 *
 * The scroll offset is held in state and updated only from the scroll event
 * (rAF-throttled), so the rendered window is a pure function of
 * `(layout, scrollTop, viewportHeight)`. Programmatic scrolls — a chapter
 * change, the page slider, a rotation re-anchor — just write `scrollTop` on the
 * element and let the resulting scroll event flow back through the same path.
 *
 * "Current page" is the most visible page (algorithm ported from Kiri v1).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PageView } from "@/lib/contracts/content";
import type { ReaderFit } from "@/lib/reader/prefs";
import {
  computeStripLayout,
  computeVisibleRange,
  mostVisiblePageIndex,
  stripRects,
} from "@/lib/reader/page-visibility";
import { PageImage } from "./page-image";

/** Scroll delta before the chrome reacts, so a jittery finger doesn't flicker it. */
const SCROLL_DIRECTION_THRESHOLD = 12;

export interface StripJump {
  index: number;
  /** A new token re-triggers the jump even for the same index. */
  token: number;
}

export interface StripViewProps {
  pages: PageView[];
  fit: ReaderFit;
  showPageNumbers: boolean;
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  onScrollDirection?: (direction: "up" | "down") => void;
  onTap?: () => void;
  jump: StripJump | null;
  endCard?: ReactNode;
  /** Drawn over each page's artwork (note pins); see `PageImage.overlay`. */
  renderPageOverlay?: (page: PageView) => ReactNode;
}

export function StripView({
  pages,
  fit,
  showPageNumbers,
  pageIndex,
  onPageIndexChange,
  onScrollDirection,
  onTap,
  jump,
  endCard,
  renderPageOverlay,
}: StripViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  const layout = useMemo(
    () => computeStripLayout(pages, size.width, size.height, fit),
    [pages, size.width, size.height, fit],
  );

  const range = useMemo(
    () => computeVisibleRange(layout, scrollTop, size.height),
    [layout, scrollTop, size.height],
  );

  // Compared against inside event handlers so a scroll never re-notifies the
  // parent with the page it just told us about.
  const pageIndexRef = useRef(pageIndex);
  useEffect(() => {
    pageIndexRef.current = pageIndex;
  }, [pageIndex]);

  const lastDirectionScrollTop = useRef(0);
  const rafRef = useRef(0);

  const handleScroll = useCallback(() => {
    if (rafRef.current !== 0) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const element = scrollRef.current;
      if (!element) return;

      const top = element.scrollTop;
      const viewportHeight = element.clientHeight;
      setScrollTop(top);

      if (layout.heights.length > 0) {
        const visible = mostVisiblePageIndex(
          stripRects(layout, top),
          viewportHeight,
          pageIndexRef.current,
        );
        if (visible !== pageIndexRef.current) {
          pageIndexRef.current = visible;
          onPageIndexChange(visible);
        }
      }

      const delta = top - lastDirectionScrollTop.current;
      if (Math.abs(delta) >= SCROLL_DIRECTION_THRESHOLD) {
        lastDirectionScrollTop.current = top;
        onScrollDirection?.(delta > 0 ? "down" : "up");
      }
    });
  }, [layout, onPageIndexChange, onScrollDirection]);

  useEffect(
    () => () => {
      if (rafRef.current !== 0) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // Track the available box. ResizeObserver rather than a window listener so a
  // rotation, an on-screen keyboard and the URL bar collapsing all count; its
  // first callback fires on observe(), which is what seeds the layout.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setSize((current) => {
        const width = element.clientWidth;
        const height = element.clientHeight;
        return current.width === width && current.height === height ? current : { width, height };
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Keep the reader on the same page across a relayout (rotation, fit change).
  const layoutSignatureRef = useRef("");
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || layout.heights.length === 0) return;
    const signature = `${size.width}x${size.height}:${fit}:${pages.length}`;
    if (layoutSignatureRef.current === signature) return;
    const hadLayout = layoutSignatureRef.current !== "";
    layoutSignatureRef.current = signature;
    if (!hadLayout) return;
    element.scrollTop = layout.offsets[pageIndexRef.current] ?? 0;
    lastDirectionScrollTop.current = element.scrollTop;
  }, [layout, size.width, size.height, fit, pages.length]);

  // External jumps: chapter change, page slider, keyboard, chapter picker.
  // `layout` is a dependency so a jump issued before the pages were measured is
  // replayed once they are; the token guard keeps a later relayout from
  // re-applying a jump the reader has already scrolled away from.
  const appliedJumpRef = useRef(-1);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !jump || layout.heights.length === 0) return;
    if (appliedJumpRef.current === jump.token) return;
    appliedJumpRef.current = jump.token;
    const target = Math.min(Math.max(jump.index, 0), layout.heights.length - 1);
    pageIndexRef.current = target;
    element.scrollTop = layout.offsets[target] ?? 0;
    lastDirectionScrollTop.current = element.scrollTop;
  }, [jump, layout]);

  // Tap (not drag, not scroll) toggles the chrome.
  const pointerStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const handlePointerDown = (event: React.PointerEvent) => {
    pointerStart.current = { x: event.clientX, y: event.clientY, time: Date.now() };
  };
  const handlePointerUp = (event: React.PointerEvent) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || !onTap) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved < 10 && Date.now() - start.time < 400) onTap();
  };

  const rendered: ReactNode[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const page = pages[index];
    if (!page) continue;
    rendered.push(
      <div
        key={page.id}
        data-page-index={index}
        style={{
          position: "absolute",
          top: layout.offsets[index] ?? 0,
          left: "50%",
          transform: "translateX(-50%)",
          width: layout.widths[index] ?? 0,
          height: layout.heights[index] ?? 0,
        }}
      >
        <PageImage
          key={page.url}
          url={page.url}
          pageNumber={page.index}
          pageCount={pages.length}
          alt={`Page ${page.index}`}
          eager={Math.abs(index - pageIndex) <= 1}
          showPageNumber={showPageNumbers}
          className="h-full w-full"
          overlay={renderPageOverlay?.(page)}
        />
      </div>,
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      data-testid="strip-scroll"
      className="h-full w-full overflow-y-auto overflow-x-hidden overscroll-contain"
    >
      <div style={{ position: "relative", height: layout.total }}>{rendered}</div>
      {endCard}
    </div>
  );
}
