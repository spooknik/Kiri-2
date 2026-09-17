"use client";

import { forwardRef, type MouseEvent } from "react";
import Link, { type LinkProps } from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import {
  decideNavigation,
  isNavigationCached,
  isPlainLeftClick,
  navigationTarget,
} from "@/lib/offline/navigation";

export type AppLinkProps = LinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps | "href"> & {
    children?: ReactNode;
  };

/**
 * Drop-in replacement for `next/link` that knows about offline mode.
 *
 * Online it *is* `next/link`. Offline it takes over the click, because a
 * client-side transition would fire an RSC request for a route the service
 * worker has never cached, that request 503s, and the router silently leaves
 * you on the page you were already on — the most confusing failure in Kiri v1's
 * offline mode.
 *
 * Offline, the target is looked up in CacheStorage:
 *   - cached  -> a full navigation, so the service worker serves the cached
 *                document (an RSC transition would still hit the network);
 *   - missing -> `/offline`, whose shell is always precached.
 *
 * The decision itself lives in `src/lib/offline/navigation.ts` so it can be
 * unit-tested; this component is only the wiring. SSR-safe: nothing here runs
 * outside a click handler.
 */
export const AppLink = forwardRef<HTMLAnchorElement, AppLinkProps>(function AppLink(
  { onClick, target, ...props },
  ref,
) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);

    // Don't hijack new-tab/new-window gestures or non-primary clicks.
    if (!isPlainLeftClick(event) || target === "_blank") return;

    const online = typeof navigator === "undefined" || navigator.onLine !== false;
    if (online) return;

    // The cache lookup is async, so the click has to be cancelled first and the
    // navigation performed by hand once the answer arrives.
    event.preventDefault();
    const href = typeof props.href === "string" ? props.href : props.href.toString();

    void isNavigationCached(href).then((cached) => {
      const destination = navigationTarget(decideNavigation({ online: false, cached }), href);
      if (destination === null) return;
      window.location.assign(destination);
    });
  }

  return <Link ref={ref} target={target} onClick={handleClick} {...props} />;
});
