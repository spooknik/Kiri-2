import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export type SpinnerSize = "sm" | "md" | "lg";

const sizeClasses: Record<SpinnerSize, string> = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
};

export type SpinnerProps = {
  size?: SpinnerSize;
  className?: string;
  /** Accessible label announced to screen readers while loading. */
  label?: string;
};

export function Spinner({ size = "md", className, label = "Loading" }: SpinnerProps) {
  return (
    <span role="status" className="inline-flex items-center">
      <Loader2 className={cn("animate-spin", sizeClasses[size], className)} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
