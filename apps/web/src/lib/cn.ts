import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines conditional class names (via `clsx`) and resolves conflicting
 * Tailwind utility classes (via `tailwind-merge`, last one wins). Use this
 * anywhere a component accepts a `className` override.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
