"use client";

/**
 * Single- and double-page reading modes.
 *
 * Renders the current spread inside the `ZoomLayer` plus its immediate
 * neighbours behind it (`visibility: hidden`, so the browser still fetches and
 * decodes them without painting). Tapping the outer thirds turns the page in
 * reading order — mirrored in `rtl` — and the middle third toggles the chrome.
 */
import { useMemo, type ReactNode } from "react";
import type { PageView } from "@/lib/contracts/content";
import { MAX_PAGE_COLUMN_WIDTH, pageAspect } from "@/lib/reader/page-visibility";
import type { Spread } from "@/lib/reader/pairing";
import type { ReaderDirection, ReaderFit } from "@/lib/reader/prefs";
import { PageImage } from "./page-image";
import { ZoomLayer } from "./zoom-layer";

export interface PagedViewProps {
  spreads: Spread<PageView>[];
  spreadIndex: number;
  pageCount: number;
  fit: ReaderFit;
  direction: ReaderDirection;
  showPageNumbers: boolean;
  /** Page columns a full spread occupies: 1 in single mode, 2 in double. */
  slotCount: 1 | 2;
  onPrev: () => void;
  onNext: () => void;
  onToggleChrome: () => void;
  /** Drawn over each page's artwork (note pins); see `PageImage.overlay`. */
  renderPageOverlay?: (page: PageView) => ReactNode;
}

function imageStyle(fit: ReaderFit): React.CSSProperties {
  switch (fit) {
    case "height":
      return { height: "100%", width: "auto", maxWidth: "100%", objectFit: "contain" };
    case "original":
      return { width: "auto", height: "auto", maxWidth: "100%", maxHeight: "100%" };
    case "width":
    default:
      return { width: "100%", height: "auto" };
  }
}

function SpreadContent({
  spread,
  fit,
  pageCount,
  showPageNumbers,
  slotCount,
  eager,
  renderPageOverlay,
}: {
  spread: Spread<PageView>;
  fit: ReaderFit;
  pageCount: number;
  showPageNumbers: boolean;
  slotCount: 1 | 2;
  eager: boolean;
  renderPageOverlay?: (page: PageView) => ReactNode;
}) {
  const style = imageStyle(fit);
  // Fit-width is the only mode that can overflow the screen, so it is the only
  // one that scrolls. The others need a *definite* height on the row, not
  // `min-height`, or the images' `height: 100%` has nothing to resolve against
  // and they fall back to their natural size.
  const scrolls = fit === "width";
  return (
    <div
      className={`h-full w-full ${scrolls ? "overflow-y-auto overscroll-contain" : "overflow-hidden"}`}
    >
      <div
        className={`mx-auto flex w-full justify-center ${
          scrolls ? "min-h-full items-start" : "h-full items-center"
        }`}
        // In fit-width, cap the spread so a wide monitor doesn't upscale the
        // scan into a blur. Fit-original and fit-height size themselves.
        style={scrolls ? { maxWidth: MAX_PAGE_COLUMN_WIDTH * slotCount } : undefined}
      >
        {spread.items.map((page) => (
          <PageImage
            key={page.url}
            url={page.url}
            pageNumber={page.index}
            pageCount={pageCount}
            alt={`Page ${page.index}`}
            eager={eager}
            showPageNumber={showPageNumbers}
            overlay={renderPageOverlay?.(page)}
            className={`min-w-0 ${scrolls ? "" : "h-full"}`}
            imgClassName="max-h-full max-w-full"
            style={style}
            wrapperStyle={{
              // A fixed column share, so the lone cover (or the last odd page)
              // in double mode stays page-sized instead of stretching across
              // the space its missing partner would have filled.
              flex: `0 0 ${100 / slotCount}%`,
              // Reserves the right box while the image decodes, so the skeleton
              // isn't a zero-height sliver in fit-width mode.
              ...(scrolls ? { aspectRatio: pageAspect(page) } : {}),
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function PagedView({
  spreads,
  spreadIndex,
  pageCount,
  fit,
  direction,
  showPageNumbers,
  slotCount,
  onPrev,
  onNext,
  onToggleChrome,
  renderPageOverlay,
}: PagedViewProps) {
  const current = spreads[spreadIndex];
  const neighbours = useMemo(
    () =>
      [spreadIndex - 1, spreadIndex + 1]
        .map((index) => ({ index, spread: spreads[index] }))
        .filter((entry): entry is { index: number; spread: Spread<PageView> } =>
          Boolean(entry.spread),
        ),
    [spreads, spreadIndex],
  );

  function handleTap(fraction: number) {
    if (fraction < 1 / 3) {
      if (direction === "rtl") onNext();
      else onPrev();
      return;
    }
    if (fraction > 2 / 3) {
      if (direction === "rtl") onPrev();
      else onNext();
      return;
    }
    onToggleChrome();
  }

  if (!current) return null;

  return (
    <div className="relative h-full w-full">
      {neighbours.map(({ index, spread }) => (
        <div
          key={index}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ visibility: "hidden" }}
        >
          <SpreadContent
            spread={spread}
            fit={fit}
            pageCount={pageCount}
            showPageNumbers={false}
            slotCount={slotCount}
            eager
          />
        </div>
      ))}

      {/* Keyed by the spread: turning the page remounts the layer, which is how
          the zoom transform resets without an effect writing state back. */}
      <ZoomLayer
        key={`${spreadIndex}:${current.firstPageIndex}`}
        onTap={handleTap}
        className="absolute inset-0 h-full w-full"
      >
        <SpreadContent
          spread={current}
          fit={fit}
          pageCount={pageCount}
          showPageNumbers={showPageNumbers}
          slotCount={slotCount}
          eager
          renderPageOverlay={renderPageOverlay}
        />
      </ZoomLayer>
    </div>
  );
}
