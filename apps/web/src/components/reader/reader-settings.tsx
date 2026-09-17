"use client";

/**
 * Reader settings dialog: layout mode, fit, direction, background, page
 * numbers, and the double-page "cover first" toggle.
 *
 * The scope switch decides which preference layer a change lands in — the
 * media type (so every manga picks it up) or just this series. See
 * `src/lib/reader/prefs.ts`.
 */
import { Dialog, Switch } from "@/components/ui";
import { cn } from "@/lib/cn";
import { MEDIA_TYPE_LABELS, type MediaType } from "@/lib/contracts/series";
import {
  READER_BACKGROUNDS,
  READER_BACKGROUND_LABELS,
  READER_DIRECTIONS,
  READER_DIRECTION_LABELS,
  READER_FITS,
  READER_FIT_LABELS,
  READER_MODES,
  READER_MODE_LABELS,
  type PrefScope,
  type ReaderPrefs,
} from "@/lib/reader/prefs";

function Segmented<T extends string>({
  label,
  values,
  labels,
  value,
  onChange,
}: {
  label: string;
  values: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {values.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === value}
            onClick={() => onChange(option)}
            className={cn(
              "focus-ring h-11 flex-1 rounded-md border px-3 text-sm font-medium",
              option === value
                ? "border-primary bg-primary-light text-primary"
                : "border-card-border bg-card text-secondary hover:bg-surface-2",
            )}
          >
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description ? <p className="text-xs text-muted">{description}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

export interface ReaderSettingsProps {
  open: boolean;
  onClose: () => void;
  prefs: ReaderPrefs;
  onChange: (patch: Partial<ReaderPrefs>) => void;
  scope: PrefScope;
  onScopeChange: (scope: PrefScope) => void;
  mediaType: MediaType;
  /** Disables the per-series scope until the series is known. */
  canScopeToSeries: boolean;
}

export function ReaderSettings({
  open,
  onClose,
  prefs,
  onChange,
  scope,
  onScopeChange,
  mediaType,
  canScopeToSeries,
}: ReaderSettingsProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Reader settings" className="max-w-lg">
      <div className="flex flex-col gap-4">
        <Segmented
          label="Mode"
          values={READER_MODES}
          labels={READER_MODE_LABELS}
          value={prefs.mode}
          onChange={(mode) => onChange({ mode })}
        />
        <Segmented
          label="Fit"
          values={READER_FITS}
          labels={READER_FIT_LABELS}
          value={prefs.fit}
          onChange={(fit) => onChange({ fit })}
        />
        <Segmented
          label="Direction"
          values={READER_DIRECTIONS}
          labels={READER_DIRECTION_LABELS}
          value={prefs.direction}
          onChange={(direction) => onChange({ direction })}
        />
        <Segmented
          label="Background"
          values={READER_BACKGROUNDS}
          labels={READER_BACKGROUND_LABELS}
          value={prefs.background}
          onChange={(background) => onChange({ background })}
        />

        <div className="flex flex-col gap-3 border-t border-card-border pt-4">
          <ToggleRow
            label="Page numbers"
            description="Show the page number on every page."
            checked={prefs.showPageNumbers}
            onChange={(showPageNumbers) => onChange({ showPageNumbers })}
          />
          {prefs.mode === "double" ? (
            <ToggleRow
              label="Cover first"
              description="Show the first page alone so spreads pair like the print edition."
              checked={prefs.coverFirst}
              onChange={(coverFirst) => onChange({ coverFirst })}
            />
          ) : null}
          <ToggleRow
            label="Only this series"
            description={
              canScopeToSeries
                ? `Off: changes apply to every ${MEDIA_TYPE_LABELS[mediaType].toLowerCase()}.`
                : "Available once the series has loaded."
            }
            checked={scope === "series" && canScopeToSeries}
            onChange={(only) => onScopeChange(only && canScopeToSeries ? "series" : "media")}
          />
        </div>
      </div>
    </Dialog>
  );
}
