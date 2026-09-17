import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type FilterChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  selected: boolean;
  children: ReactNode;
};

/**
 * Pill-shaped toggle button for a horizontally-scrollable filter row (status,
 * scope, adult, ...). Generic — new addition to `src/components/library/`,
 * not tied to a particular filter's data shape, so it's reusable wherever a
 * single-select or multi-select chip is needed.
 */
export function FilterChip({ selected, className, children, ...props }: FilterChipProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={selected}
      className={cn(
        "focus-ring inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors",
        selected
          ? "border-transparent bg-primary-light text-primary"
          : "border-card-border bg-transparent text-muted hover:border-primary/40 hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
