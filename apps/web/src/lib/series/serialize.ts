/**
 * Prisma rows -> contract response types.
 *
 * Every date becomes an ISO string here (and nowhere else), so
 * `src/lib/contracts/series.ts` is the only description of the wire format the
 * client needs. `seriesIncludeFor` is the matching `include`: one query per
 * list page, no N+1.
 */
import type { LibraryEntry, Prisma, Series } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/types";
import { canEditSeries } from "@/lib/authz";
import type {
  LibraryEntryView,
  MemberProgress,
  SeriesDetail,
  SeriesSummary,
} from "@/lib/contracts";
import { coverUrlFor } from "@/lib/cover-storage";

/**
 * `include` for a series as one user sees it: their own entry (at most one,
 * thanks to the unique `(userId, seriesId)`), the creator's name badge, and
 * the total number of trackers.
 */
export function seriesIncludeFor(userId: string) {
  return {
    createdBy: { select: { id: true, displayName: true } },
    library: { where: { userId }, take: 1 },
    _count: { select: { library: true } },
  } satisfies Prisma.SeriesInclude;
}

/** A series row loaded with {@link seriesIncludeFor}. */
export interface SeriesRow extends Series {
  createdBy: { id: string; displayName: string };
  /** The current user's entry, or empty when they do not track the series. */
  library: LibraryEntry[];
  _count: { library: number };
}

/** A library entry loaded with its owner, for the members list. */
export interface MemberRow extends LibraryEntry {
  user: { id: string; displayName: string };
}

/** `include` for the members list of a shared series. */
export const memberInclude = {
  user: { select: { id: true, displayName: true } },
} satisfies Prisma.LibraryEntryInclude;

function toRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function toEntryView(entry: LibraryEntry): LibraryEntryView {
  return {
    status: entry.status,
    currentChapter: entry.currentChapter,
    rating: entry.rating,
    notes: entry.notes,
    favorite: entry.favorite,
    joinedAt: entry.joinedAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export function toSeriesSummary(row: SeriesRow, user: SessionUser): SeriesSummary {
  const entry = row.library[0];
  return {
    id: row.id,
    title: row.title,
    originalTitle: row.originalTitle,
    mediaType: row.mediaType,
    visibility: row.visibility,
    isAdult: row.isAdult,
    isBookClub: row.isBookClub,
    coverUrl: coverUrlFor(row),
    tags: row.tags,
    chapterCount: row.chapterCount,
    lastChapterAt: row.lastChapterAt?.toISOString() ?? null,
    totalChapters: row.totalChapters,
    createdBy: { id: row.createdBy.id, displayName: row.createdBy.displayName },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    entry: entry ? toEntryView(entry) : null,
    readerCount: row._count.library,
    canEdit: canEditSeries(user, row),
  };
}

export function toMemberProgress(entry: MemberRow): MemberProgress {
  return {
    user: { id: entry.user.id, displayName: entry.user.displayName },
    status: entry.status,
    currentChapter: entry.currentChapter,
    rating: entry.rating,
    updatedAt: entry.updatedAt.toISOString(),
  };
}

/**
 * Detail view. `members` is only exposed for SHARED series: a private shelf
 * has exactly one member and listing it would leak nothing useful, but the
 * contract promises an empty array so clients need no special case.
 */
export function toSeriesDetail(
  row: SeriesRow,
  user: SessionUser,
  members: MemberRow[],
): SeriesDetail {
  return {
    ...toSeriesSummary(row, user),
    synopsis: row.synopsis,
    publicationYear: row.publicationYear,
    totalVolumes: row.totalVolumes,
    sourceUrl: row.sourceUrl,
    malId: row.malId,
    externalIds: toRecord(row.externalIds),
    members: row.visibility === "SHARED" ? members.map(toMemberProgress) : [],
  };
}
