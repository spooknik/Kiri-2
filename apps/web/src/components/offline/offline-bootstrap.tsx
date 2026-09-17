"use client";

import { useEffect, useState } from "react";
import { installOfflineTransports } from "@/lib/offline/transports";
import { reconcileCatalog } from "@/lib/offline/reconcile";
import { warmShellCache } from "@/lib/offline/shell-cache";
import { flushSyncQueue } from "@/lib/offline/sync-queue";
import { registerServiceWorker } from "@/lib/offline/sw-registration";
import { UpdateToast } from "./update-toast";

/**
 * Everything offline mode needs at startup, mounted once in the root layout.
 *
 *   1. Point reading-progress and note writes at the sync queue. This happens
 *      first and synchronously-ish, before any reader can mount, so no write
 *      ever escapes down the direct HTTP path while the app is still booting.
 *   2. Register the service worker immediately (production only — `sw.js` is
 *      built by `serwist build`, which only runs in `npm run build`).
 *   3. Flush the sync queue on load, on `online`, and whenever the tab becomes
 *      visible. Those three foreground triggers are what stand in for the
 *      Background Sync API, which iOS Safari does not have.
 *   4. Reconcile the download catalog against CacheStorage, so a browser that
 *      quietly evicted a series is not still advertising it as readable.
 *   5. Warm the `/read` shell into the `pages` cache. It cannot be precached
 *      (it is behind the proxy, and a precache request is not a navigation —
 *      see serwist.config.mjs), so this signed-in fetch is what makes opening a
 *      downloaded chapter work with no network.
 *
 * Renders nothing but the update toast.
 */
export function OfflineBootstrap() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    installOfflineTransports();

    const unregister = registerServiceWorker({
      onUpdateReady: () => setUpdateReady(true),
    });

    const flush = () => {
      void flushSyncQueue();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") flush();
    };

    flush();
    void reconcileCatalog();
    void warmShellCache();

    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", onVisible);
      unregister();
    };
  }, []);

  return <UpdateToast open={updateReady} onDismiss={() => setUpdateReady(false)} />;
}
