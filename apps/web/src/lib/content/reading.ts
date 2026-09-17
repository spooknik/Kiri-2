/**
 * Per-user reading state: where you are in a series, which chapters you have
 * finished, and the "continue reading" rail.
 *
 * Two rules keep the tracker and the reader from drifting apart:
 *   - reaching the last page of a chapter marks it read (the reader never has
 *     to send a second request, and an offline replay of positions produces the
 *     same read markers);
 *   - marking a chapter read advances the manual `LibraryEntry.currentChapter`
 *     counter, never backwards, and lifts PLAN_TO_READ to READING.
 */
import type { Prisma } from "@/generated/prisma/client";
import { badRequest, notFound } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/types";
import { assertCanViewSeries, visibleSeriesWhere } from "@/lib/authz";
import { getChapterListItem } from "@/lib/content/chapters";
import type {
  ChapterListItem,
  ContinueReadingItem,
  ContinueReadingResponse,
  ReadingPositionView,
  UpdatePositionInput,
} from "@/lib/contracts";
import { coverUrlFor } from "@/lib/cover-storage";
import { prisma } from "@/lib/prisma";

const DEFAULT_CONTINUE_LIMIT = 10;

const SERIES_ACCESS_SELECT = {
  id: true,
  visibility: true,
  isAdult: true,
  createdById: true,
} satisfies Prisma.SeriesSelect;

interface ReadableChapter {
  id: string;
  seriesId: string;
  number: number | null;
  pageCount: number;
}

/**
 * Create the read marker and advance the library entry. Authorization is the
 * caller's job — both entry points check view access first.
 */
async function markRead(userId: string, chapter: ReadableChapter): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.chapterRead.upsert({
      where: { userId_chapterId: { userId, chapterId: chapter.id } },
      create: { userId, chapterId: chapter.id, seriesId: chapter.seriesId },
      // Already read: keep the original readAt, it is a "first finished" stamp.
      update: {},
    });

    const entry = await tx.libraryEntry.findUnique({
      where: { userId_seriesId: { userId, seriesId: chapter.seriesId } },
      select: { id: true, status: true, currentChapter: true },
    });

    if (!entry) {
      // Reading a chapter of a series you do not track starts tracking it.
      await tx.libraryEntry.create({
        data: {
          userId,
          seriesId: chapter.seriesId,
          status: "READING",
          currentChapter: chapter.number ?? 0,
        },
      });
      return;
    }

    const data: Prisma.LibraryEntryUpdateInput = {};
    if (chapter.number !== null && chapter.number > entry.currentChapter) {
      data.currentChapter = chapter.number;
    }
    if (entry.status === "PLAN_TO_READ") {
      data.status = "READING";
    }
    if (Object.keys(data).length > 0) {
      await tx.libraryEntry.update({ where: { id: entry.id }, data });
    }
  });
}

/** PUT /api/series/:id/position */
export async function updatePosition(
  user: SessionUser,
  seriesId: string,
  input: UpdatePositionInput,
): Promise<ReadingPositionView> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: SERIES_ACCESS_SELECT,
  });
  if (!series) throw notFound("Series");
  assertCanViewSeries(user, series);

  let chapter: ReadableChapter | null = null;
  if (input.chapterId !== null) {
    chapter = await prisma.chapter.findUnique({
      where: { id: input.chapterId },
      select: { id: true, seriesId: true, number: true, pageCount: true },
    });
    if (!chapter || chapter.seriesId !== seriesId) {
      throw badRequest("That chapter is not part of this series");
    }
  }

  const position = await prisma.readingPosition.upsert({
    where: { userId_seriesId: { userId: user.id, seriesId } },
    create: {
      userId: user.id,
      seriesId,
      chapterId: input.chapterId,
      pageIndex: input.pageIndex,
    },
    update: {
      chapterId: input.chapterId,
      pageIndex: input.pageIndex,
      updatedAt: new Date(),
    },
    select: { chapterId: true, pageIndex: true, updatedAt: true },
  });

  // `pageIndex` is 0-based, so the last page is pageCount - 1.
  if (chapter && chapter.pageCount > 0 && input.pageIndex >= chapter.pageCount - 1) {
    await markRead(user.id, chapter);
  }

  return {
    chapterId: position.chapterId,
    pageIndex: position.pageIndex,
    updatedAt: position.updatedAt.toISOString(),
  };
}

/** PUT /api/chapters/:id/read */
export async function setChapterRead(
  user: SessionUser,
  chapterId: string,
  read: boolean,
): Promise<ChapterListItem> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: {
      id: true,
      seriesId: true,
      number: true,
      pageCount: true,
      series: { select: SERIES_ACCESS_SELECT },
    },
  });
  if (!chapter) throw notFound("Chapter");
  assertCanViewSeries(user, chapter.series);

  if (read) {
    await markRead(user.id, chapter);
  } else {
    // The library entry keeps its counter: un-marking one chapter is not a
    // statement about how far the reader got overall.
    await prisma.chapterRead.deleteMany({ where: { userId: user.id, chapterId } });
  }

  return getChapterListItem(user.id, chapterId);
}

/** GET /api/library/continue */
export async function continueReading(
  user: SessionUser,
  limit: number = DEFAULT_CONTINUE_LIMIT,
): Promise<ContinueReadingResponse> {
  const rows = await prisma.readingPosition.findMany({
    where: { userId: user.id, series: visibleSeriesWhere(user) },
    orderBy: { updatedAt: "desc" },
    take: Math.max(1, limit),
    select: {
      pageIndex: true,
      updatedAt: true,
      series: {
        select: {
          id: true,
          title: true,
          mediaType: true,
          coverFile: true,
          updatedAt: true,
        },
      },
      chapter: {
        select: { id: true, slug: true, title: true, number: true, pageCount: true },
      },
    },
  });

  const items: ContinueReadingItem[] = rows.map((row) => ({
    series: {
      id: row.series.id,
      title: row.series.title,
      coverUrl: coverUrlFor(row.series),
      mediaType: row.series.mediaType,
    },
    chapter: row.chapter
      ? {
          id: row.chapter.id,
          slug: row.chapter.slug,
          title: row.chapter.title,
          number: row.chapter.number,
          pageCount: row.chapter.pageCount,
        }
      : null,
    pageIndex: row.pageIndex,
    updatedAt: row.updatedAt.toISOString(),
  }));

  return { items };
}
