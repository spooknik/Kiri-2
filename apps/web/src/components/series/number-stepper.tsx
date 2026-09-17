"use client";

import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/cn";

export interface NumberStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

/**
 * Generic −/+ numeric stepper with a plain numeric input in the middle. Not
 * series-specific — reusable for any bounded numeric quantity. New generic
 * component (ui/ is read-only).
 */
export function NumberStepper({
  value,
  onChange,
  min = 0,
  max = 100_000,
  step = 1,
  disabled,
  id,
  className,
  ...aria
}: NumberStepperProps) {
  function clamp(next: number) {
    return Math.min(max, Math.max(min, next));
  }

  function handleInputChange(raw: string) {
    if (raw.trim() === "") return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      onChange(clamp(parsed));
    }
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <button
        type="button"
        onClick={() => onChange(clamp(value - step))}
        disabled={disabled || value <= min}
        aria-label="Decrease"
        className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-card-border text-foreground hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Minus className="h-4 w-4" aria-hidden="true" />
      </button>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => handleInputChange(e.target.value)}
        className="focus-ring h-11 w-20 rounded-md border border-card-border bg-card px-2 text-center text-sm tabular-nums text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        {...aria}
      />
      <button
        type="button"
        onClick={() => onChange(clamp(value + step))}
        disabled={disabled || value >= max}
        aria-label="Increase"
        className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-card-border text-foreground hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
