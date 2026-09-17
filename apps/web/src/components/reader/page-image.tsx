"use client";

/**
 * One page image, with a skeleton while it decodes and a retry button when it
 * fails.
 *
 * A plain `<img>` on purpose: page URLs are already immutable and unoptimised
 * (`next.config.ts` sets `images.unoptimized`), the service worker caches them
 * byte for byte for offline reading, and the reader sizes every page itself
 * from the dimensions in the API response. `next/image` would add a second
 * cache layer and its own layout maths on top of that.
 */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";

/** The rendered image box, in wrapper-relative pixels. */
interface OverlayBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function sameBox(a: OverlayBox | null, b: OverlayBox): boolean {
  return (
    a !== null &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

export interface PageImageProps {
  url: string;
  /** 1-based page number shown in the corner badge. */
  pageNumber: number;
  pageCount: number;
  alt: string;
  /** Decode immediately (current page and its neighbours). */
  eager?: boolean;
  showPageNumber?: boolean;
  /** Applied to the wrapper, which owns the reserved box. */
  className?: string;
  /** Applied to the `<img>` (fit mode decides how it fills the box). */
  imgClassName?: string;
  /** Inline sizing for the `<img>`, for fit modes Tailwind can't express. */
  style?: React.CSSProperties;
  /** Inline sizing for the wrapper (e.g. an aspect ratio while loading). */
  wrapperStyle?: React.CSSProperties;
  /**
   * Rendered in a box that tracks the `<img>` exactly — not the wrapper, which
   * is larger than the artwork in the fit modes that letterbox. Note pins live
   * here, so their normalised coordinates land on the same pixels in every fit
   * mode and at every zoom level.
   */
  overlay?: ReactNode;
}

export function PageImage({
  url,
  pageNumber,
  pageCount,
  alt,
  eager = false,
  showPageNumber = false,
  className,
  imgClassName,
  style,
  wrapperStyle,
  overlay,
}: PageImageProps) {
  // Callers key this component by `url`, so a different image is a fresh mount
  // and these start over on their own.
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  // Page URLs are immutable-cached, so a retry has to bust the cache entry that
  // failed; the query parameter is ignored by the image route.
  const src = attempt === 0 ? url : `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}`;

  // Only measured while something is actually drawn on top, so pages without
  // notes cost exactly what they did before.
  const imgRef = useRef<HTMLImageElement>(null);
  const [overlayBox, setOverlayBox] = useState<OverlayBox | null>(null);
  const hasOverlay = overlay !== undefined && overlay !== null && overlay !== false;

  useEffect(() => {
    if (!hasOverlay) return;
    const element = imgRef.current;
    if (!element) return;

    const measure = () => {
      const next: OverlayBox = {
        left: element.offsetLeft,
        top: element.offsetTop,
        width: element.offsetWidth,
        height: element.offsetHeight,
      };
      setOverlayBox((current) => (sameBox(current, next) ? current : next));
    };
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasOverlay, status, src]);

  return (
    <div
      className={cn("relative flex items-center justify-center", className)}
      style={wrapperStyle}
    >
      {status !== "error" ? (
        <img
          key={src}
          ref={imgRef}
          src={src}
          alt={alt}
          decoding="async"
          loading={eager ? "eager" : "lazy"}
          draggable={false}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("error")}
          className={cn(
            "block transition-opacity duration-150",
            imgClassName ?? "h-full w-full object-contain",
            status === "loaded" ? "opacity-100" : "opacity-0",
          )}
          style={style}
        />
      ) : null}

      {status === "loading" ? (
        <div
          className="absolute inset-0 animate-pulse bg-white/5"
          aria-hidden="true"
          data-testid="page-skeleton"
        />
      ) : null}

      {status === "error" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/5 p-4 text-center">
          <p className="text-sm text-white/70">Page {pageNumber} failed to load</p>
          <button
            type="button"
            onClick={() => {
              setStatus("loading");
              setAttempt((value) => value + 1);
            }}
            className="focus-ring inline-flex h-11 items-center gap-2 rounded-md border border-white/20 px-4 text-sm font-medium text-white hover:bg-white/10"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}

      {showPageNumber ? (
        <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white/80">
          {pageNumber} / {pageCount}
        </span>
      ) : null}

      {hasOverlay && overlayBox ? (
        <div
          data-testid="page-overlay"
          // Transparent to input; the markers inside re-enable it for themselves,
          // so the reader's tap zones and pinch-zoom keep working underneath.
          className="pointer-events-none absolute"
          style={{
            left: overlayBox.left,
            top: overlayBox.top,
            width: overlayBox.width,
            height: overlayBox.height,
          }}
        >
          {overlay}
        </div>
      ) : null}
    </div>
  );
}
