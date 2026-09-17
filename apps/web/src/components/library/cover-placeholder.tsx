import { cn } from "@/lib/cn";
import type { MediaType } from "@/lib/contracts";

const MEDIA_TYPE_TINTS: Record<MediaType, string> = {
  MANGA: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  MANHWA: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  MANHUA: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  COMIC: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  LIGHT_NOVEL: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  NOVEL: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  BOOK: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  OTHER: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

function getInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? "";
  const second = words[1] ?? "";
  if (!first) return "?";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase();
}

export type CoverPlaceholderProps = {
  title: string;
  mediaType: MediaType;
  className?: string;
};

/** Generated stand-in for a series without a stored cover: title initials on a media-type-tinted tile. */
export function CoverPlaceholder({ title, mediaType, className }: CoverPlaceholderProps) {
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center text-sm font-semibold tracking-wide",
        MEDIA_TYPE_TINTS[mediaType],
        className,
      )}
      aria-hidden="true"
    >
      {getInitials(title)}
    </div>
  );
}
