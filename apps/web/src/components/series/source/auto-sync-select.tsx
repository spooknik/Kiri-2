"use client";

import { Select } from "@/components/ui";
import type { AutoSyncMode } from "@/lib/contracts/plugins";
import { AUTO_SYNC_INTERVAL_PRESETS, nearestPresetMinutes } from "./auto-sync-options";

export interface AutoSyncSelectProps {
  mode: AutoSyncMode;
  intervalMinutes: number | null;
  disabled?: boolean;
  onChange: (mode: AutoSyncMode, intervalMinutes: number | null) => void;
}

/**
 * Inherit (global) / Disabled / Custom, with a second preset select
 * (6h/12h/24h/2d/1w) appearing only for Custom. Mapping lives in
 * `auto-sync-options.ts`.
 */
export function AutoSyncSelect({ mode, intervalMinutes, disabled, onChange }: AutoSyncSelectProps) {
  function handleModeChange(next: AutoSyncMode) {
    if (next === "CUSTOM") {
      onChange("CUSTOM", nearestPresetMinutes(intervalMinutes));
    } else {
      onChange(next, null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Auto-sync"
        value={mode}
        disabled={disabled}
        onChange={(e) => handleModeChange(e.target.value as AutoSyncMode)}
        className="h-9 w-auto"
      >
        <option value="INHERIT">Inherit (global)</option>
        <option value="DISABLED">Disabled</option>
        <option value="CUSTOM">Custom</option>
      </Select>
      {mode === "CUSTOM" ? (
        <Select
          aria-label="Sync interval"
          value={nearestPresetMinutes(intervalMinutes)}
          disabled={disabled}
          onChange={(e) => onChange("CUSTOM", Number(e.target.value))}
          className="h-9 w-auto"
        >
          {AUTO_SYNC_INTERVAL_PRESETS.map((preset) => (
            <option key={preset.minutes} value={preset.minutes}>
              {preset.label}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}
