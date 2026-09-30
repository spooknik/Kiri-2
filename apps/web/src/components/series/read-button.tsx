"use client";

import { BookOpen } from "lucide-react";
import { Button, Skeleton } from "@/components/ui";
import { useChapters } from "@/hooks/use-chapters";
import { buildContinueReadingHref } from "@/lib/reader-url";

export interface ReadButtonProps {
  seriesId: string;
}

/**
 * The series page's primary call to action: resume at the saved position, or
 * start at the first unread chapter. Shares the chapters query (and cache) with
 * `ChaptersSection`; renders nothing when no chapter is readable yet.
 */
export function ReadButton({ seriesId }: ReadButtonProps) {
  const { data, isPending } = useChapters(seriesId);

  if (isPending) {
    return <Skeleton className="h-12 w-full" />;
  }
  if (!data) {
    return null;
  }

  const href = buildContinueReadingHref(seriesId, data.position, data.chapters);
  if (!href) {
    return null;
  }

  const current = data.position?.chapterId
    ? data.chapters.find((chapter) => chapter.id === data.position?.chapterId)
    : undefined;
  const chapterLabel = current ? ` · Ch. ${current.number ?? current.title}` : "";

  return (
    <Button href={href} size="lg" className="w-full">
      <BookOpen className="h-5 w-5" aria-hidden="true" />
      <span className="truncate">
        {data.position?.chapterId ? `Continue reading${chapterLabel}` : "Start reading"}
      </span>
    </Button>
  );
}
