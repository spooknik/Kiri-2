/**
 * Pure preset mapping for `AutoSyncSelect`'s "Custom" interval sub-select —
 * kept dependency-free (no React) so it's trivially unit-testable.
 * `updateSourceSchema.autoSyncIntervalMinutes` (src/lib/contracts/plugins.ts)
 * is clamped to [60, 43_200]; every preset here falls inside that range.
 */
export interface AutoSyncIntervalPreset {
  label: string;
  minutes: number;
}

export const AUTO_SYNC_INTERVAL_PRESETS: readonly AutoSyncIntervalPreset[] = [
  { label: "Every 6 hours", minutes: 6 * 60 },
  { label: "Every 12 hours", minutes: 12 * 60 },
  { label: "Every 24 hours", minutes: 24 * 60 },
  { label: "Every 2 days", minutes: 2 * 24 * 60 },
  { label: "Every week", minutes: 7 * 24 * 60 },
];

export const DEFAULT_CUSTOM_INTERVAL_MINUTES = 24 * 60;

/**
 * Snaps an arbitrary interval (as stored) to the closest preset, so the
 * "Custom" sub-select always shows a valid option even if the stored value
 * doesn't exactly match one (e.g. set by a future version, or migrated
 * data). `null`/`undefined` falls back to the 24h default.
 */
export function nearestPresetMinutes(minutes: number | null | undefined): number {
  if (minutes == null || !Number.isFinite(minutes)) {
    return DEFAULT_CUSTOM_INTERVAL_MINUTES;
  }
  let best = AUTO_SYNC_INTERVAL_PRESETS[0]!;
  let bestDiff = Math.abs(best.minutes - minutes);
  for (const preset of AUTO_SYNC_INTERVAL_PRESETS) {
    const diff = Math.abs(preset.minutes - minutes);
    if (diff < bestDiff) {
      best = preset;
      bestDiff = diff;
    }
  }
  return best.minutes;
}
