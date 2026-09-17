/**
 * The library list: filter, full-text search, sort and paginate, all in
 * PostgreSQL. V1 fetched everything and filtered adult content in the browser
 * (`library-list.tsx:324`); here `visibleSeriesWhere` is ANDed into every
 * query, so a row the user may not see never leaves the database.
 *
 * Three page-selection strategies, one result shape:
 *   - `rank`     — the default when `q` is set: ids come from the tsvector
 *                  index, ordered by ts_rank, then sliced;
 *   - `progress` — ordered by *my* entry, so the query runs over
 *                  `library_entry` and hydrates the series afterwards;
 *   - everything else — one `series` query with the include, keyset-paginated.
 */
import type { Prisma } from "@/generated/prisma/client";
import { badRequest } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/types";
import { visibleSeriesWhere } from "@/lib/authz";
import {
  READING_STATUSES,
  type LibraryPage,
  type LibraryQuery,
  type LibrarySort,
  type ReadingStatus,
} from "@/lib/contracts";
import { prisma } from "@/lib/prisma";
import { seriesIncludeFor, toSeriesSummary, type SeriesRow } from "@/lib/series/serialize";
import { decodeCursor, encodeCursor, type CursorValue, type LibraryCursor } from "./cursor";

type Direction = "asc" | "desc";
type EffectiveSort = LibrarySort | "rank";

interface SeriesSortSpec {
  field: "updatedAt" | "sortTitle" | "createdAt" | "lastChapterAt";
  kind: "date" | "text";
  /** Nullable columns always sort NULLS LAST, in both directions. */
  nullable: boolean;
  direction: Direction;
}

const SERIES_SORTS = {
  updated: { field: "updatedAt", kind: "date", nullable: false, direction: "desc" },
  title: { field: "sortTitle", kind: "text", nullable: false, direction: "asc" },
  added: { field: "createdAt", kind: "date", nullable: false, direction: "desc" },
  lastChapter: { field: "lastChapterAt", kind: "date", nullable: true, direction: "desc" },
} as const satisfies Record<string, SeriesSortSpec>;

type SeriesSortKey = keyof typeof SERIES_SORTS;

const ENTRY_SORT_SPEC: SeriesSortSpec = {
  field: "updatedAt",
  kind: "date",
  nullable: false,
  direction: "desc",
};

interface RankRow {
  id: string;
  rank: number;
}

interface PageResult {
  rows: SeriesRow[];
  nextCursor: string | null;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export async function listLibrary(user: SessionUser, query: LibraryQuery): Promise<LibraryPage> {
  const cursor = parseCursor(query.cursor);
  const sort = resolveSort(query);

  // The FTS lookup runs first: its ids become part of the `where` that both
  // the page and the total count share.
  const ranked = query.q ? await searchSeriesIds(query.q) : null;
  const where = buildWhere(user, query, ranked?.map((row) => row.id) ?? null);

  const [page, total, statusCounts] = await Promise.all([
    selectPage(user, query, where, sort, cursor, ranked),
    prisma.series.count({ where }),
    loadStatusCounts(user.id),
  ]);

  return {
    items: page.rows.map((row) => toSeriesSummary(row, user)),
    nextCursor: page.nextCursor,
    total,
    statusCounts,
  };
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every filter as one AND list. `visibleSeriesWhere` is always the first
 * element and is never conditional.
 */
function buildWhere(
  user: SessionUser,
  query: LibraryQuery,
  matchedIds: string[] | null,
): Prisma.SeriesWhereInput {
  const filters: Prisma.SeriesWhereInput[] = [visibleSeriesWhere(user)];

  // status and favorite are properties of *my* entry, so they imply tracking.
  const entry: Prisma.LibraryEntryWhereInput = { userId: user.id };
  let requiresEntry = query.scope === "tracked";
  if (query.status) {
    entry.status = query.status;
    requiresEntry = true;
  }
  if (query.favorite === "1") {
    entry.favorite = true;
    requiresEntry = true;
  }
  if (requiresEntry) filters.push({ library: { some: entry } });

  if (query.scope === "created") filters.push({ createdById: user.id });
  if (query.mediaType) filters.push({ mediaType: query.mediaType });
  if (query.tag) filters.push({ tags: { has: query.tag } });
  if (query.bookClub === "1") filters.push({ isBookClub: true });

  // For everyone else `visibleSeriesWhere` has already removed adult series,
  // so the toggle would only be able to hide their own.
  if (user.showAdult) {
    if (query.adult === "exclude") filters.push({ isAdult: false });
    if (query.adult === "only") filters.push({ isAdult: true });
  }

  if (matchedIds) filters.push({ id: { in: matchedIds } });

  return { AND: filters };
}

async function loadStatusCounts(userId: string): Promise<Record<ReadingStatus, number>> {
  const grouped = await prisma.libraryEntry.groupBy({
    by: ["status"],
    where: { userId },
    _count: { _all: true },
  });
  const counts = Object.fromEntries(READING_STATUSES.map((status) => [status, 0])) as Record<
    ReadingStatus,
    number
  >;
  for (const row of grouped) {
    counts[row.status] = row._count._all;
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Full-text search                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Ids of series matching `q`, best first. The `simple` query matches titles
 * and tags verbatim, the `english` one stems the synopsis; ORing them means a
 * search for "spice" finds "Spice and Wolf" and a stemmed synopsis hit alike.
 * Capped at 500 ids — far more than any page, and it keeps the id list that
 * feeds the Prisma `where` bounded.
 */
async function searchSeriesIds(q: string): Promise<RankRow[]> {
  return prisma.$queryRaw<RankRow[]>`
    SELECT s."id" AS id,
           ts_rank(
             s."search_vector",
             websearch_to_tsquery('simple', ${q}) || websearch_to_tsquery('english', ${q})
           )::float8 AS rank
    FROM "series" s
    WHERE s."search_vector" @@ (
            websearch_to_tsquery('simple', ${q}) || websearch_to_tsquery('english', ${q})
          )
    ORDER BY rank DESC, s."id" ASC
    LIMIT 500
  `;
}

/* -------------------------------------------------------------------------- */
/* Sorting and pagination                                                     */
/* -------------------------------------------------------------------------- */

/**
 * With a search term and no explicit sort choice, relevance wins. `updated`
 * is the schema default, so it doubles as "the client did not pick a sort".
 */
function resolveSort(query: LibraryQuery): EffectiveSort {
  if (query.q && query.sort === "updated") return "rank";
  return query.sort;
}

function parseCursor(raw: string | undefined): LibraryCursor | null {
  if (!raw) return null;
  const cursor = decodeCursor(raw);
  if (!cursor) throw badRequest("Invalid cursor");
  return cursor;
}

function selectPage(
  user: SessionUser,
  query: LibraryQuery,
  where: Prisma.SeriesWhereInput,
  sort: EffectiveSort,
  cursor: LibraryCursor | null,
  ranked: RankRow[] | null,
): Promise<PageResult> {
  if (sort === "rank") return selectRankPage(user, query, where, cursor, ranked ?? []);
  if (sort === "progress") return selectProgressPage(user, query, where, cursor);
  return selectSeriesPage(user, query, where, sort, cursor);
}

async function selectSeriesPage(
  user: SessionUser,
  query: LibraryQuery,
  where: Prisma.SeriesWhereInput,
  sort: SeriesSortKey,
  cursor: LibraryCursor | null,
): Promise<PageResult> {
  const spec = SERIES_SORTS[sort];
  const direction = query.order ?? spec.direction;
  const rows: SeriesRow[] = await prisma.series.findMany({
    where: cursor ? { AND: [where, seriesKeyset(spec, direction, cursor)] } : where,
    orderBy: seriesOrderBy(spec, direction),
    take: query.limit + 1,
    include: seriesIncludeFor(user.id),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      hasMore && last ? encodeCursor({ v: seriesCursorValue(spec, last), id: last.id }) : null,
  };
}

/** Ordered by my own entry, so the driving table is `library_entry`. */
async function selectProgressPage(
  user: SessionUser,
  query: LibraryQuery,
  where: Prisma.SeriesWhereInput,
  cursor: LibraryCursor | null,
): Promise<PageResult> {
  const direction = query.order ?? ENTRY_SORT_SPEC.direction;
  const comparator = direction === "desc" ? "lt" : "gt";
  const entryWhere: Prisma.LibraryEntryWhereInput = { userId: user.id, series: where };

  if (cursor) {
    const at = cursorFieldValue(ENTRY_SORT_SPEC, cursor.v);
    if (at === null) throw badRequest("Invalid cursor");
    entryWhere.OR = [
      { updatedAt: { [comparator]: at } },
      { AND: [{ updatedAt: at }, { seriesId: { [comparator]: cursor.id } }] },
    ];
  }

  const entries = await prisma.libraryEntry.findMany({
    where: entryWhere,
    orderBy: [{ updatedAt: direction }, { seriesId: direction }],
    take: query.limit + 1,
    select: { seriesId: true, updatedAt: true },
  });

  const hasMore = entries.length > query.limit;
  const page = hasMore ? entries.slice(0, query.limit) : entries;
  const last = page.at(-1);
  return {
    rows: await fetchSeriesRows(
      user,
      page.map((row) => row.seriesId),
    ),
    nextCursor:
      hasMore && last ? encodeCursor({ v: last.updatedAt.toISOString(), id: last.seriesId }) : null,
  };
}

/**
 * Relevance order comes from the raw query, so the page is sliced in memory
 * from the (bounded) ranked id list intersected with the filtered set.
 */
async function selectRankPage(
  user: SessionUser,
  query: LibraryQuery,
  where: Prisma.SeriesWhereInput,
  cursor: LibraryCursor | null,
  ranked: RankRow[],
): Promise<PageResult> {
  if (ranked.length === 0) return { rows: [], nextCursor: null };

  const allowed = await prisma.series.findMany({ where, select: { id: true } });
  const allowedIds = new Set(allowed.map((row) => row.id));
  const ordered = ranked.filter((row) => allowedIds.has(row.id));

  let start = 0;
  if (cursor) {
    const rank = typeof cursor.v === "number" ? cursor.v : Number(cursor.v);
    if (!Number.isFinite(rank)) throw badRequest("Invalid cursor");
    // Mirrors "ORDER BY rank DESC, id ASC": strictly after the cursor row.
    const index = ordered.findIndex(
      (row) => row.rank < rank || (row.rank === rank && row.id > cursor.id),
    );
    start = index === -1 ? ordered.length : index;
  }

  const slice = ordered.slice(start, start + query.limit);
  const hasMore = ordered.length > start + query.limit;
  const last = slice.at(-1);
  return {
    rows: await fetchSeriesRows(
      user,
      slice.map((row) => row.id),
    ),
    nextCursor: hasMore && last ? encodeCursor({ v: last.rank, id: last.id }) : null,
  };
}

/** Hydrate a page of ids, preserving the order they were given in. */
async function fetchSeriesRows(user: SessionUser, ids: string[]): Promise<SeriesRow[]> {
  if (ids.length === 0) return [];
  const rows: SeriesRow[] = await prisma.series.findMany({
    where: { id: { in: ids } },
    include: seriesIncludeFor(user.id),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

function seriesOrderBy(
  spec: SeriesSortSpec,
  direction: Direction,
): Prisma.SeriesOrderByWithRelationInput[] {
  const primary = (
    spec.nullable
      ? { [spec.field]: { sort: direction, nulls: "last" } }
      : { [spec.field]: direction }
  ) as Prisma.SeriesOrderByWithRelationInput;
  // id is the stable tie-break that makes the keyset cursor exact.
  return [primary, { id: direction }];
}

function seriesKeyset(
  spec: SeriesSortSpec,
  direction: Direction,
  cursor: LibraryCursor,
): Prisma.SeriesWhereInput {
  const comparator = direction === "desc" ? "lt" : "gt";
  const value = cursorFieldValue(spec, cursor.v);

  if (value === null) {
    // Nulls sort last, so the remainder is the rest of the null block.
    return {
      AND: [{ [spec.field]: null }, { id: { [comparator]: cursor.id } }],
    } as Prisma.SeriesWhereInput;
  }

  const branches: Prisma.SeriesWhereInput[] = [
    { [spec.field]: { [comparator]: value } } as Prisma.SeriesWhereInput,
    {
      AND: [{ [spec.field]: value }, { id: { [comparator]: cursor.id } }],
    } as Prisma.SeriesWhereInput,
  ];
  if (spec.nullable) {
    branches.push({ [spec.field]: null } as Prisma.SeriesWhereInput);
  }
  return { OR: branches };
}

function seriesCursorValue(spec: SeriesSortSpec, row: SeriesRow): CursorValue {
  switch (spec.field) {
    case "updatedAt":
      return row.updatedAt.toISOString();
    case "createdAt":
      return row.createdAt.toISOString();
    case "sortTitle":
      return row.sortTitle;
    case "lastChapterAt":
      return row.lastChapterAt?.toISOString() ?? null;
  }
}

function cursorFieldValue(spec: SeriesSortSpec, value: CursorValue): Date | string | null {
  if (value === null) return null;
  if (spec.kind === "date") {
    const at = new Date(String(value));
    if (Number.isNaN(at.getTime())) throw badRequest("Invalid cursor");
    return at;
  }
  return String(value);
}
