"use client";

import { cn } from "@/lib/cn";

export type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

/**
 * A toggle switch (`role="switch"`). The visible track is 24×44px, but the
 * button itself keeps a 44×44 minimum hit area for touch.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
  ...aria
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "focus-ring inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...aria}
    >
      <span
        className={cn(
          "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
          checked ? "bg-primary" : "bg-surface-2",
        )}
      >
        <span
          className={cn(
            "inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform",
            checked && "translate-x-[22px]",
          )}
        />
      </span>
    </button>
  );
}
