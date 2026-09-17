"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/cn";

export interface RatingStarsProps {
  value: number | null;
  onChange: (value: number | null) => void;
  max?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * Generic 1..max star rating picker. Clicking the currently-selected star
 * clears the rating. Not series-specific — reusable for any 1..N rating.
 * New generic component (ui/ is read-only).
 */
export function RatingStars({ value, onChange, max = 10, disabled, className }: RatingStarsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Rating"
      className={cn("flex flex-wrap items-center gap-0.5", className)}
    >
      {Array.from({ length: max }, (_, i) => i + 1).map((star) => {
        const filled = value !== null && star <= value;
        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} out of ${max}`}
            disabled={disabled}
            onClick={() => onChange(value === star ? null : star)}
            className="focus-ring flex h-7 w-7 items-center justify-center rounded disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Star
              className={cn("h-4 w-4", filled ? "fill-warning text-warning" : "text-muted")}
              aria-hidden="true"
            />
          </button>
        );
      })}
      {value !== null ? (
        <span className="ml-1 text-xs tabular-nums text-muted">
          {value}/{max}
        </span>
      ) : null}
    </div>
  );
}
