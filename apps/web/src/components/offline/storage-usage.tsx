"use client";

import { HardDrive } from "lucide-react";
import { useStorageUsage } from "@/hooks/use-offline";
import { formatBytes } from "@/lib/format";

/**
 * How much of the browser's storage budget Kiri's downloads occupy.
 *
 * `navigator.storage.estimate()` reports the *origin's* whole usage, not just
 * ours, which is the number that actually predicts eviction — so that is what
 * is shown, with the caveat spelled out when the browser refuses to answer.
 */
export function StorageUsage() {
  const { usage, quota, persisted } = useStorageUsage();

  if (usage === null || quota === null || quota === 0) {
    return (
      <p className="text-xs text-muted">
        This browser doesn&apos;t report how much storage is available.
      </p>
    );
  }

  const fraction = Math.min(1, Math.max(0, usage / quota));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <HardDrive className="h-4 w-4" aria-hidden="true" />
          {formatBytes(usage)} of {formatBytes(quota)} used
        </span>
        <span>{persisted ? "Protected from cleanup" : "May be cleared by the browser"}</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-label="Storage used"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${Math.max(2, Math.round(fraction * 100))}%` }}
        />
      </div>
    </div>
  );
}
