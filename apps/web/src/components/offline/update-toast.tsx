"use client";

import { RefreshCw, X } from "lucide-react";
import { applyServiceWorkerUpdate } from "@/lib/offline/sw-registration";

export interface UpdateToastProps {
  open: boolean;
  onDismiss: () => void;
}

/**
 * "Update available — Reload", shown when a newer service worker has taken
 * over. It is not the generic `useToast` banner on purpose: this one must not
 * auto-dismiss (a stale tab keeps loading chunks the new precache no longer
 * has) and it survives route changes, since it is mounted next to
 * `OfflineBootstrap` in the root layout.
 */
export function UpdateToast({ open, onDismiss }: UpdateToastProps) {
  if (!open) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-[calc(var(--shell-bottom-nav-height,4rem)+env(safe-area-inset-bottom))] z-[60] mx-auto flex w-[min(28rem,calc(100%-2rem))] items-center gap-3 rounded-lg border border-card-border bg-card px-4 py-3 shadow-lg"
    >
      <RefreshCw className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="flex-1 text-sm text-foreground">A new version of Kiri is ready.</p>
      <button
        type="button"
        onClick={applyServiceWorkerUpdate}
        className="focus-ring rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss update notice"
        className="focus-ring rounded-md p-1 text-muted hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
