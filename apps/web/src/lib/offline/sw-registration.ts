/**
 * Service worker registration.
 *
 * Two things V1 got wrong and this fixes:
 *
 *   1. **Register immediately.** V1 waited for `window.load` before calling
 *      `register()`, so a user who opened the app once on a slow connection and
 *      navigated away never got a worker — and therefore never got offline
 *      mode. The registration request is cheap and off the critical path;
 *      there is nothing to defer.
 *   2. **Tell the user about an update.** With `skipWaiting` the new worker
 *      takes over while the page is still running the old build's chunks, so a
 *      route the old bundle asks for can 404 against the new precache. The
 *      update toast turns that into an explicit "Reload".
 *
 * The worker is only registered in production: `serwist build` runs after
 * `next build`, so `public/sw.js` simply does not exist in dev, and registering
 * a 404 throws.
 */

export interface RegisterOptions {
  /** Called when a newer worker is installed/active and a reload would adopt it. */
  onUpdateReady: () => void;
  /** Overridable for tests; defaults to `process.env.NODE_ENV === "production"`. */
  enabled?: boolean;
}

/** Handle to the worker that should be asked to skip waiting, if any. */
let waitingWorker: ServiceWorker | null = null;

function isSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

/**
 * Registers `/sw.js` and wires update detection. Returns a teardown that
 * removes the listeners (the registration itself is intentionally permanent).
 */
export function registerServiceWorker(options: RegisterOptions): () => void {
  const enabled = options.enabled ?? process.env.NODE_ENV === "production";
  if (!enabled || !isSupported()) return () => {};

  let disposed = false;
  const cleanups: (() => void)[] = [];

  const announce = (worker: ServiceWorker | null) => {
    if (disposed) return;
    waitingWorker = worker;
    options.onUpdateReady();
  };

  const onControllerChange = () => {
    // A new worker claimed this page (skipWaiting + clientsClaim). The running
    // document is now mixing old chunks with a new precache: offer a reload.
    announce(null);
  };
  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  cleanups.push(() =>
    navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange),
  );

  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((registration) => {
      if (disposed) return;

      // A worker left waiting by a previous visit.
      if (registration.waiting && navigator.serviceWorker.controller) {
        announce(registration.waiting);
      }

      const onUpdateFound = () => {
        const installing = registration.installing;
        if (!installing) return;
        const onStateChange = () => {
          if (installing.state !== "installed") return;
          // No controller means this is the very first install: nothing to
          // reload, the current page was never served by a worker.
          if (navigator.serviceWorker.controller) {
            announce(registration.waiting ?? installing);
          }
        };
        installing.addEventListener("statechange", onStateChange);
      };
      registration.addEventListener("updatefound", onUpdateFound);
      cleanups.push(() => registration.removeEventListener("updatefound", onUpdateFound));
    })
    .catch((error: unknown) => {
      // Surfaced, not swallowed: a failed registration silently disables the
      // whole of offline mode, and that must be diagnosable in DevTools.
      console.error("[kiri] service worker registration failed:", error);
    });

  return () => {
    disposed = true;
    for (const cleanup of cleanups) cleanup();
  };
}

/**
 * Adopt the new worker and reload. Posting `SKIP_WAITING` is a no-op when the
 * worker already activated itself (`skipWaiting: true` in sw.ts), and the
 * reload is what actually swaps the page onto the new build.
 */
export function applyServiceWorkerUpdate(): void {
  try {
    waitingWorker?.postMessage({ type: "SKIP_WAITING" });
  } catch {
    // Nothing to do: the reload below is the part that matters.
  }
  waitingWorker = null;
  if (typeof window !== "undefined") window.location.reload();
}
