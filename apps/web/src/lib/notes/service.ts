/**
 * Notes service: the only module that writes `Note` rows.
 *
 * Notes are anchored to a series, optionally to a chapter, optionally to a
 * page, and optionally to a normalised point on that page's image. Replies are
 * a self-relation and always inherit their parent's anchor, so a thread never
 * spreads across pages.
 *
 * Two invariants shape everything here:
 *
 *   - **Visibility follows the series.** Every entry point resolves the series
 *     first and calls `assertCanViewSeries`, so a private series answers 404
 *     for everyone but its creator — including for a note id that leaked.
 *   - **Writes are idempotent on the client-minted id.** `PUT /api/notes/:id`
 *     is the only creation path, which is what lets the offline queue replay a
 *     note without risking a duplicate (`src/lib/notes/sync.ts`).
 *
 * Spoiler gating lives in `./spoilers.ts` and mention parsing in
 * `./mentions.ts`; both are pure so this module stays about data access.
 */
import type { Prisma } from "@/generated/prisma/client";
import { badRequest, conflict, forbidden, notFound } from "@/lib/api";
import { isAdmin, type SessionUser } from "@/lib/auth/types";
import { assertCanViewSeries } from "@/lib/authz";
import type {
  NotesPage,
  NotesQuery,
  NotesSummary,
  NoteThread,
  NoteView,
  UpsertNoteInput,
} from "@/lib/contracts/notes";
import { findMentions, type MentionCandidate } from "@/lib/notes/mentions";
import { noteAnchor, noteSelect, toNoteView, type NoteRow } from "@/lib/notes/serialize";
import { isNoteHidden, type NoteViewer, type ViewerProgress } from "@/lib/notes/spoilers";
import { createNotifications } from "@/lib/notifications";
import { prisma } from "@/lib/prisma";

/** Upper bound on the users scanned for `@name` mentions in one write. */
const MENTION_CANDIDATE_LIMIT = 500;
/** How much of the note body a notification quotes. */
const NOTIFICATION_EXCERPT = 140;

const SERIES_ACCESS_SELECT = {
  id: true,
  title: true,
  visibility: true,
  isAdult: true,
  createdById: true,
} satisfies Prisma.SeriesSelect;

type SeriesRow = Prisma.SeriesGetPayload<{ select: typeof SERIES_ACCESS_SELECT }>;

export interface UpsertNoteResult {
  note: NoteView;
  /** False when the id already existed and the note was edited in place. */
  created: boolean;
}

export interface GetThreadOptions {
  /** The viewer asked to see spoiler-gated bodies. */
  reveal?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Shared loading                                                             */
/* -------------------------------------------------------------------------- */

async function loadViewableSeries(user: SessionUser, seriesId: string): Promise<SeriesRow> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: SERIES_ACCESS_SELECT,
  });
  if (!series) throw notFound("Series");
  assertCanViewSeries(user, series);
  return series;
}

/**
 * The viewer's furthest point in the series, in the 1-based page space notes
 * use (`ReadingPosition.pageIndex` is 0-based, so it is shifted here).
 */
async function loadProgress(userId: string, seriesId: string): Promise<ViewerProgress> {
  const [reads, position] = await Promise.all([
    prisma.chapterRead.findMany({
      where: { userId, seriesId },
      select: { chapter: { select: { sortIndex: true } } },
    }),
    prisma.readingPosition.findUnique({
      where: { userId_seriesId: { userId, seriesId } },
      select: { pageIndex: true, chapter: { select: { sortIndex: true } } },
    }),
  ]);

  return {
    readChapterSortIndexes: new Set(reads.map((read) => read.chapter.sortIndex)),
    position:
      position && position.chapter
        ? { chapterSortIndex: position.chapter.sortIndex, page: position.pageIndex + 1 }
        : null,
  };
}

function viewerOf(user: SessionUser): NoteViewer {
  return { id: user.id, showSpoilers: user.showSpoilers };
}

function gate(row: NoteRow, viewer: NoteViewer, progress: ViewerProgress): boolean {
  return isNoteHidden(
    { authorId: row.userId, isSpoiler: row.isSpoiler, anchor: noteAnchor(row) },
    viewer,
    progress,
  );
}

/* -------------------------------------------------------------------------- */
/* Cursor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Keyset cursor on `(createdAt desc, id desc)`. Deliberately duplicated from
 * `src/lib/notifications.ts` for the same reason that file gives: twenty lines
 * of codec are cheaper than a third module owning pagination.
 */
interface KeysetCursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })).toString(
    "base64url",
  );
}

function decodeCursor(raw: string | undefined): KeysetCursor | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw badRequest("Invalid cursor");
  }
  if (!parsed || typeof parsed !== "object") throw badRequest("Invalid cursor");
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== "string" || typeof i !== "string") throw badRequest("Invalid cursor");
  const createdAt = new Date(c);
  if (Number.isNaN(createdAt.getTime())) throw badRequest("Invalid cursor");
  return { createdAt, id: i };
}

/* -------------------------------------------------------------------------- */
/* Anchors                                                                    */
/* -------------------------------------------------------------------------- */

interface ResolvedAnchor {
  chapterId: string | null;
  pageIndex: number | null;
  pinX: number | null;
  pinY: number | null;
}

/**
 * Validate the anchor a client asked for. Replies never get one of their own:
 * they inherit the parent's chapter and page and drop any pin, so a thread
 * cannot be spread over two pages by a crafted request.
 */
async function resolveAnchor(
  seriesId: string,
  input: UpsertNoteInput,
  parent: { chapterId: string | null; pageIndex: number | null } | null,
): Promise<ResolvedAnchor> {
  if (parent) {
    return { chapterId: parent.chapterId, pageIndex: parent.pageIndex, pinX: null, pinY: null };
  }

  if (input.pageIndex !== null && input.chapterId === null) {
    throw badRequest("A page note needs a chapter");
  }

  const hasPin = input.pinX !== null || input.pinY !== null;
  if (hasPin && (input.pinX === null || input.pinY === null)) {
    throw badRequest("A pin needs both coordinates");
  }
  if (hasPin && input.pageIndex === null) {
    throw badRequest("A pin needs a page");
  }

  if (input.chapterId !== null) {
    const chapter = await prisma.chapter.findUnique({
      where: { id: input.chapterId },
      select: { id: true, seriesId: true, pageCount: true },
    });
    if (!chapter || chapter.seriesId !== seriesId) {
      throw badRequest("That chapter is not part of this series");
    }
    if (input.pageIndex !== null && input.pageIndex > chapter.pageCount) {
      throw badRequest(`That chapter only has ${chapter.pageCount} pages`);
    }
  }

  return {
    chapterId: input.chapterId,
    pageIndex: input.pageIndex,
    pinX: input.pinX,
    pinY: input.pinY,
  };
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

function excerpt(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > NOTIFICATION_EXCERPT
    ? `${collapsed.slice(0, NOTIFICATION_EXCERPT - 1)}...`
    : collapsed;
}

/**
 * Deep link for a note: the reader at the right page with the notes panel
 * open, or the series page for a note that has no chapter.
 */
export function noteLink(note: {
  id: string;
  seriesId: string;
  chapterId: string | null;
  pageIndex: number | null;
}): string {
  if (note.chapterId === null) return `/series/${note.seriesId}`;
  const params = new URLSearchParams({ series: note.seriesId, chapter: note.chapterId });
  // Note pages are 1-based, and so is the reader's `page` parameter.
  if (note.pageIndex !== null) params.set("page", String(note.pageIndex));
  params.set("notes", "1");
  params.set("note", note.id);
  return `/read?${params.toString()}`;
}

/** Everyone who can see the series, and therefore can be mentioned in it. */
async function mentionCandidates(series: SeriesRow): Promise<MentionCandidate[]> {
  if (series.visibility === "PRIVATE") {
    return prisma.user.findMany({
      where: { id: series.createdById },
      select: { id: true, displayName: true },
    });
  }
  return prisma.user.findMany({
    where: series.isAdult ? { OR: [{ showAdult: true }, { id: series.createdById }] } : {},
    select: { id: true, displayName: true },
    take: MENTION_CANDIDATE_LIMIT,
  });
}

async function notifyAboutNewNote(
  author: SessionUser,
  series: SeriesRow,
  row: NoteRow,
  parentAuthorId: string | null,
): Promise<void> {
  const link = noteLink(row);
  const notified = new Set<string>([author.id]);

  if (parentAuthorId !== null && parentAuthorId !== author.id) {
    notified.add(parentAuthorId);
    await createNotifications({
      userIds: [parentAuthorId],
      type: "NOTE_REPLY",
      title: `${author.displayName} replied to your note`,
      message: excerpt(row.body),
      link,
      seriesId: series.id,
      noteId: row.id,
      // One notification per reply, however often the write is replayed.
      dedupeKey: `note-reply:${row.id}`,
    });
  }

  const mentioned = findMentions(row.body, await mentionCandidates(series)).filter(
    (id) => !notified.has(id),
  );
  if (mentioned.length === 0) return;

  await createNotifications({
    userIds: mentioned,
    type: "NOTE_MENTION",
    title: `${author.displayName} mentioned you in ${series.title}`,
    message: excerpt(row.body),
    link,
    seriesId: series.id,
    noteId: row.id,
    dedupeKey: `note-mention:${row.id}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/** Serialise one row for the caller, applying the spoiler gate. */
async function viewFor(user: SessionUser, row: NoteRow, reveal?: boolean): Promise<NoteView> {
  const progress = await loadProgress(user.id, row.seriesId);
  const hidden = gate(row, viewerOf(user), progress);
  return toNoteView(row, { viewerId: user.id, hidden, reveal: reveal ?? false });
}

/**
 * Create the note with the client's id, or edit it in place when that id is
 * already the caller's note. Replays (offline sync, a retried request) land on
 * the update branch and notify nobody a second time.
 */
export async function upsertNote(
  user: SessionUser,
  noteId: string,
  input: UpsertNoteInput,
): Promise<UpsertNoteResult> {
  const series = await loadViewableSeries(user, input.seriesId);

  const existing = await prisma.note.findUnique({
    where: { id: noteId },
    select: { id: true, userId: true, seriesId: true, body: true, deletedAt: true },
  });

  if (existing) {
    if (existing.userId !== user.id) {
      throw forbidden("Only the author can change this note");
    }
    if (existing.seriesId !== input.seriesId) {
      throw conflict("That note id already belongs to another series");
    }
    if (existing.deletedAt !== null) {
      throw conflict("That note was deleted");
    }
    const updated = await prisma.note.update({
      where: { id: noteId },
      data: {
        body: input.body,
        isSpoiler: input.isSpoiler,
        // A replay of the identical body is not an edit.
        ...(existing.body === input.body ? {} : { editedAt: new Date() }),
      },
      select: noteSelect,
    });
    return { note: await viewFor(user, updated), created: false };
  }

  let parent: {
    id: string;
    userId: string;
    chapterId: string | null;
    pageIndex: number | null;
  } | null = null;

  if (input.parentId !== null) {
    const parentRow = await prisma.note.findUnique({
      where: { id: input.parentId },
      select: { id: true, userId: true, seriesId: true, chapterId: true, pageIndex: true },
    });
    if (!parentRow || parentRow.seriesId !== input.seriesId) {
      throw badRequest("That note is not part of this series");
    }
    parent = {
      id: parentRow.id,
      userId: parentRow.userId,
      chapterId: parentRow.chapterId,
      pageIndex: parentRow.pageIndex,
    };
  }

  const anchor = await resolveAnchor(input.seriesId, input, parent);

  let created: NoteRow;
  try {
    created = await prisma.note.create({
      data: {
        id: noteId,
        userId: user.id,
        seriesId: input.seriesId,
        chapterId: anchor.chapterId,
        pageIndex: anchor.pageIndex,
        pinX: anchor.pinX,
        pinY: anchor.pinY,
        body: input.body,
        parentId: parent?.id ?? null,
        isSpoiler: input.isSpoiler,
      },
      select: noteSelect,
    });
  } catch (error) {
    // Two replays of the same offline op racing each other: the loser reads
    // the winner's row instead of failing.
    if (isUniqueViolation(error)) {
      const row = await prisma.note.findUnique({ where: { id: noteId }, select: noteSelect });
      if (row) return { note: await viewFor(user, row), created: false };
    }
    throw error;
  }

  await notifyAboutNewNote(user, series, created, parent?.userId ?? null);
  return { note: await viewFor(user, created), created: true };
}

/** Author-only body/spoiler edit. Stamps `editedAt`. */
export async function editNote(
  user: SessionUser,
  noteId: string,
  patch: { body?: string; isSpoiler?: boolean },
): Promise<NoteView> {
  const existing = await prisma.note.findUnique({
    where: { id: noteId },
    select: { id: true, userId: true, seriesId: true, deletedAt: true },
  });
  if (!existing) throw notFound("Note");
  await loadViewableSeries(user, existing.seriesId);
  if (existing.userId !== user.id) throw forbidden("Only the author can edit this note");
  if (existing.deletedAt !== null) throw notFound("Note");
  if (patch.body === undefined && patch.isSpoiler === undefined) {
    throw badRequest("Nothing to change");
  }

  const updated = await prisma.note.update({
    where: { id: noteId },
    data: {
      ...(patch.body === undefined ? {} : { body: patch.body, editedAt: new Date() }),
      ...(patch.isSpoiler === undefined ? {} : { isSpoiler: patch.isSpoiler }),
    },
    select: noteSelect,
  });
  return viewFor(user, updated);
}

/**
 * Soft delete by the author or an admin. The row stays so its replies keep
 * their thread; every view of it serialises with an empty body, which the UI
 * renders as "deleted".
 */
export async function deleteNote(user: SessionUser, noteId: string): Promise<void> {
  const existing = await prisma.note.findUnique({
    where: { id: noteId },
    select: { id: true, userId: true, seriesId: true, deletedAt: true },
  });
  if (!existing) throw notFound("Note");
  await loadViewableSeries(user, existing.seriesId);
  if (existing.userId !== user.id && !isAdmin(user)) {
    throw forbidden("Only the author or an admin can delete this note");
  }
  if (existing.deletedAt !== null) return;

  await prisma.note.update({ where: { id: noteId }, data: { deletedAt: new Date() } });
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `{ [pageIndex]: count }` for one chapter's markers. Counts every live
 * top-level note including spoiler-gated ones: a marker says "someone wrote
 * something here", which is not itself a spoiler.
 */
async function pageCounts(seriesId: string, chapterId: string): Promise<Record<string, number>> {
  const grouped = await prisma.note.groupBy({
    by: ["pageIndex"],
    where: { seriesId, chapterId, parentId: null, deletedAt: null },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const group of grouped) {
    // Chapter-level notes (no page) are keyed "0" so the reader can badge them.
    counts[String(group.pageIndex ?? 0)] = group._count._all;
  }
  return counts;
}

/**
 * One keyset page of top-level notes, newest first.
 *
 * Replies never appear here (they arrive through `getThread`); `replyCount` is
 * what the list shows instead. Notes hidden *by progress* are dropped unless
 * `includeHidden` is set — the reader asks for them so it can draw a shield
 * where the note is — while notes hidden because their author flagged them a
 * spoiler always arrive (with an empty body), since their existence is not the
 * secret. Both that filter and the deleted-note filter run after the query, so
 * a page can be shorter than `limit` and still have a `nextCursor`.
 */
export async function listNotes(
  user: SessionUser,
  seriesId: string,
  query: NotesQuery,
): Promise<NotesPage> {
  await loadViewableSeries(user, seriesId);
  const progress = await loadProgress(user.id, seriesId);
  const viewer = viewerOf(user);
  const cursor = decodeCursor(query.cursor);

  const rows = await prisma.note.findMany({
    where: {
      seriesId,
      parentId: null,
      ...(query.chapterId === undefined ? {} : { chapterId: query.chapterId }),
      ...(query.pageIndex === undefined ? {} : { pageIndex: query.pageIndex }),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: noteSelect,
  });

  const hasMore = rows.length > query.limit;
  const window = hasMore ? rows.slice(0, query.limit) : rows;
  const last = window[window.length - 1];

  const items: NoteView[] = [];
  for (const row of window) {
    // A deleted note is only worth showing while it still holds a thread.
    if (row.deletedAt !== null && row._count.replies === 0) continue;
    const hidden = gate(row, viewer, progress);
    if (hidden && !row.isSpoiler && query.includeHidden !== "1") continue;
    items.push(toNoteView(row, { viewerId: user.id, hidden }));
  }

  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    pageCounts: query.chapterId === undefined ? {} : await pageCounts(seriesId, query.chapterId),
  };
}

/**
 * One note plus its direct replies. `reveal` returns spoiler-gated bodies —
 * the viewer clicked through the shield, so they chose to see them.
 */
export async function getThread(
  user: SessionUser,
  noteId: string,
  options: GetThreadOptions = {},
): Promise<NoteThread> {
  const row = await prisma.note.findUnique({ where: { id: noteId }, select: noteSelect });
  if (!row) throw notFound("Note");
  await loadViewableSeries(user, row.seriesId);

  const replies = await prisma.note.findMany({
    where: { parentId: noteId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: noteSelect,
  });

  const progress = await loadProgress(user.id, row.seriesId);
  const viewer = viewerOf(user);
  const reveal = options.reveal === true;

  return {
    note: toNoteView(row, { viewerId: user.id, hidden: gate(row, viewer, progress), reveal }),
    replies: replies.map((reply) =>
      toNoteView(reply, { viewerId: user.id, hidden: gate(reply, viewer, progress), reveal }),
    ),
  };
}

/** Per-chapter counts for the series page. Counts are not spoiler-gated. */
export async function getSummary(user: SessionUser, seriesId: string): Promise<NotesSummary> {
  await loadViewableSeries(user, seriesId);

  const [total, seriesLevel, grouped] = await Promise.all([
    prisma.note.count({ where: { seriesId, deletedAt: null } }),
    prisma.note.count({ where: { seriesId, chapterId: null, deletedAt: null } }),
    prisma.note.groupBy({
      by: ["chapterId"],
      where: { seriesId, chapterId: { not: null }, deletedAt: null },
      _count: { _all: true },
    }),
  ]);

  const byChapter: NotesSummary["byChapter"] = [];
  for (const group of grouped) {
    if (group.chapterId === null) continue;
    byChapter.push({ chapterId: group.chapterId, count: group._count._all });
  }

  return { total, byChapter, seriesLevel };
}
