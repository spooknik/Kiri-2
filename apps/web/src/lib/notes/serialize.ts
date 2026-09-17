/**
 * Prisma note rows -> the `NoteView` wire shape.
 *
 * Same rule as the other serialisers: dates become ISO strings here and
 * nowhere else. Two body substitutions live here as well, because they are
 * part of the wire contract rather than of the storage:
 *
 *   - a spoiler-gated note (`hidden`) has its body withheld until the client
 *     asks for it with `reveal=1`;
 *   - a soft-deleted note keeps its row (its replies still hang off it) but
 *     serialises with an empty body. `body === "" && !hidden` is what the UI
 *     renders as "deleted".
 */
import type { Prisma } from "@/generated/prisma/client";
import type { NoteView } from "@/lib/contracts/notes";
import type { NoteAnchor } from "@/lib/notes/spoilers";

export const noteSelect = {
  id: true,
  seriesId: true,
  chapterId: true,
  pageIndex: true,
  pinX: true,
  pinY: true,
  body: true,
  parentId: true,
  isSpoiler: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  user: { select: { id: true, displayName: true } },
  chapter: { select: { id: true, title: true, number: true, sortIndex: true } },
  _count: { select: { replies: true } },
} satisfies Prisma.NoteSelect;

export type NoteRow = Prisma.NoteGetPayload<{ select: typeof noteSelect }>;

/** Where the note sits in the series, for the spoiler gate. */
export function noteAnchor(row: NoteRow): NoteAnchor {
  return { chapterSortIndex: row.chapter?.sortIndex ?? null, pageIndex: row.pageIndex };
}

export interface NoteViewOptions {
  /** The viewer, so `canEdit` and the author bypass can be decided. */
  viewerId: string;
  /** Result of the spoiler gate for this row. */
  hidden: boolean;
  /** The client explicitly asked to see gated bodies (`reveal=1`). */
  reveal?: boolean;
}

export function toNoteView(row: NoteRow, options: NoteViewOptions): NoteView {
  const deleted = row.deletedAt !== null;
  const withheld = options.hidden && options.reveal !== true;
  return {
    id: row.id,
    seriesId: row.seriesId,
    chapterId: row.chapterId,
    chapter: row.chapter
      ? {
          id: row.chapter.id,
          title: row.chapter.title,
          number: row.chapter.number,
          sortIndex: row.chapter.sortIndex,
        }
      : null,
    pageIndex: row.pageIndex,
    pinX: row.pinX,
    pinY: row.pinY,
    body: deleted || withheld ? "" : row.body,
    author: { id: row.user.id, displayName: row.user.displayName },
    parentId: row.parentId,
    isSpoiler: row.isSpoiler,
    hidden: options.hidden,
    replyCount: row._count.replies,
    canEdit: !deleted && row.userId === options.viewerId,
    editedAt: row.editedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
