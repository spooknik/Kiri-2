"use client";

/**
 * Pinch / double-tap zoom for the paged modes, in CSS transforms and pointer
 * events only (no gesture library).
 *
 * - Double tap toggles between 1x and `maxScale`, anchored on the tap so the
 *   panel you tapped stays under your finger.
 * - Two pointers pinch, anchored on the midpoint.
 * - One pointer pans, but only while zoomed, so a normal tap still reaches the
 *   tap zones.
 * - A single tap that isn't part of a double tap is reported through `onTap`
 *   with the x position as a 0..1 fraction of the layer, which is what the
 *   caller turns into "previous page / toggle chrome / next page".
 *
 * The transform resets by remounting: the caller gives this component a `key`
 * that changes with the spread, which is cheaper to reason about than syncing a
 * reset back into state.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

const DOUBLE_TAP_MS = 280;
const TAP_SLOP_PX = 12;

interface Transform {
  scale: number;
  x: number;
  y: number;
  /** Animate this change (a double tap) rather than tracking a finger. */
  animate: boolean;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0, animate: true };

export interface ZoomLayerProps {
  children: ReactNode;
  maxScale?: number;
  /** Tap position as a fraction of the layer width (0 = left edge). */
  onTap?: (fractionX: number) => void;
  className?: string;
}

export function ZoomLayer({ children, maxScale = 2, onTap, className }: ZoomLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{
    distance: number;
    transform: Transform;
    midX: number;
    midY: number;
  } | null>(null);
  const panStart = useRef<{ x: number; y: number; transform: Transform } | null>(null);
  const tapStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTap = useRef<{ x: number; y: number; time: number } | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const zoomed = transform.scale > 1.01;

  useEffect(
    () => () => {
      if (tapTimer.current) clearTimeout(tapTimer.current);
    },
    [],
  );

  /** Keeps the scaled content from being dragged off screen. */
  const clamp = useCallback((next: Transform): Transform => {
    const element = containerRef.current;
    if (!element) return next;
    const maxX = (Math.max(next.scale, 1) - 1) * (element.clientWidth / 2);
    const maxY = (Math.max(next.scale, 1) - 1) * (element.clientHeight / 2);
    return {
      ...next,
      x: Math.min(Math.max(next.x, -maxX), maxX),
      y: Math.min(Math.max(next.y, -maxY), maxY),
    };
  }, []);

  /**
   * Scales around a screen point: with `transform-origin: center`, a point `f`
   * measured from the centre stays put when `t = f - (f - t0) * s / s0`.
   */
  const scaleAround = useCallback(
    (from: Transform, scale: number, clientX: number, clientY: number, animate: boolean) => {
      const element = containerRef.current;
      if (!element) return { ...from, scale, animate };
      const rect = element.getBoundingClientRect();
      const fx = clientX - rect.left - rect.width / 2;
      const fy = clientY - rect.top - rect.height / 2;
      const ratio = scale / from.scale;
      return {
        scale,
        x: fx - (fx - from.x) * ratio,
        y: fy - (fy - from.y) * ratio,
        animate,
      };
    },
    [],
  );

  const fireTap = useCallback(
    (clientX: number) => {
      const element = containerRef.current;
      if (!element || !onTap) return;
      const rect = element.getBoundingClientRect();
      const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
      onTap(Math.min(Math.max(fraction, 0), 1));
    },
    [onTap],
  );

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) {
        pinch.current = {
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          transform,
          midX: (a.x + b.x) / 2,
          midY: (a.y + b.y) / 2,
        };
      }
      panStart.current = null;
      tapStart.current = null;
      return;
    }

    tapStart.current = { x: event.clientX, y: event.clientY, time: Date.now() };
    panStart.current = zoomed ? { x: event.clientX, y: event.clientY, transform } : null;
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const active = pinch.current;
    if (active && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const scale = Math.min(
        Math.max(active.transform.scale * (distance / active.distance), 1),
        maxScale,
      );
      setTransform(clamp(scaleAround(active.transform, scale, active.midX, active.midY, false)));
      return;
    }

    const pan = panStart.current;
    if (pan) {
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      if (Math.hypot(dx, dy) > TAP_SLOP_PX) tapStart.current = null;
      setTransform(
        clamp({
          scale: pan.transform.scale,
          x: pan.transform.x + dx,
          y: pan.transform.y + dy,
          animate: false,
        }),
      );
      return;
    }

    const start = tapStart.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) {
      tapStart.current = null;
    }
  }

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) panStart.current = null;

    const start = tapStart.current;
    tapStart.current = null;
    if (!start) return;
    if (Date.now() - start.time > 400) return;

    const previous = lastTap.current;
    const now = Date.now();
    const isDoubleTap =
      previous !== null &&
      now - previous.time < DOUBLE_TAP_MS &&
      Math.hypot(start.x - previous.x, start.y - previous.y) < 30;

    if (isDoubleTap) {
      lastTap.current = null;
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
        tapTimer.current = null;
      }
      setTransform((current) =>
        current.scale > 1.01
          ? IDENTITY
          : clamp(scaleAround(current, maxScale, start.x, start.y, true)),
      );
      return;
    }

    lastTap.current = { x: start.x, y: start.y, time: now };
    if (tapTimer.current) clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null;
      fireTap(start.x);
    }, DOUBLE_TAP_MS);
  }

  return (
    <div
      ref={containerRef}
      data-testid="zoom-layer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      className={className}
      style={{ touchAction: zoomed ? "none" : "manipulation", overflow: "hidden" }}
    >
      <div
        style={{
          height: "100%",
          width: "100%",
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: "center center",
          transition: transform.animate ? "transform 150ms ease-out" : "none",
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </div>
  );
}
