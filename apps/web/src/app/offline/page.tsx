import type { Metadata } from "next";
import { OfflineHub } from "@/components/offline/offline-hub";

/**
 * `/offline` — the offline hub.
 *
 * Prerendered on purpose, and deliberately outside the `(app)` route group: the
 * route reads no cookies and no headers, so Next emits a static shell that
 * `serwist build` picks up (`precachePrerendered`) and precaches. That shell is
 * the service worker's navigation fallback, so it must not depend on the app
 * shell's server-rendered header or on any request-time data.
 *
 * It is also a public path (`src/lib/auth/public-paths.ts`): a cold PWA launch
 * in airplane mode has no way to prove it has a session, and being bounced to
 * `/login` — which cannot render offline — is exactly the dead end this page
 * exists to prevent.
 */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Offline",
};

export default function OfflinePage() {
  return <OfflineHub />;
}
