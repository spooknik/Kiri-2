import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type PageContainerProps = HTMLAttributes<HTMLElement>;

/**
 * The page's `<main>` landmark: centers content, matches the header's max
 * width, and reserves space at the bottom for the fixed `BottomNav`.
 */
export function PageContainer({ className, ...props }: PageContainerProps) {
  return (
    <main
      className={cn("pb-safe mx-auto w-full max-w-2xl flex-1 px-4 py-4", className)}
      {...props}
    />
  );
}
