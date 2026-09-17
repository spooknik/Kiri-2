/**
 * Notes end to end: the four route handlers, the spoiler gate against real
 * `ChapterRead`/`ReadingPosition` rows, reply and mention notifications, and
 * the offline sync entry point.
 *
 * Only `@/lib/auth/session` is mocked (the project's standard way of driving
 * route handlers as a given user, per test/factories.ts). Series come from the
 * real `createSeries`; chapters and pages are written straight through Prisma
 * because notes never touch the files on disk — see
 * `src/lib/content/pipeline.int.test.ts` for the full upload path.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";

import {
  DELETE as deleteNoteRoute,
  GET as getNoteRoute,
  PATCH as patchNoteRoute,
  PUT as putNoteRoute,
} from "@/app/api/notes/[id]/route";
import { GET as listNotesRoute } from "@/app/api/series/[id]/notes/route";
import { GET as summaryRoute } from "@/app/api/series/[id]/notes/summary/route";

import type { SessionUser } from "@/lib/auth/types";
import type {
  NotesPage,
  NotesSummary,
  NoteThread,
  NoteView,
  UpsertNoteInput,
} from "@/lib/contracts/notes";
import { applyNoteSyncOp } from "@/lib/notes/sync";
import { prisma } from "@/lib/prisma";
import { createSeries } from "@/lib/series/service";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

beforeEach(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

async function makeSeries(
  user: SessionUser,
  overrides: { title?: string; visibility?: "SHARED" | "PRIVATE" } = {},
): Promise<string> {
  const series = await createSeries(user, {
    title: overrides.title ?? "Notes Test Series",
    originalTitle: null,
    synopsis: null,
    mediaType: "MANGA",
    visibility: overrides.visibility ?? "SHARED",
    isAdult: false,
    publicationYear: null,
    totalChapters: null,
    totalVolumes: null,
    tags: [],
    sourceUrl: null,
    coverUrl: null,
    malId: null,
    isBookClub: false,
    status: "PLAN_TO_READ",
    currentChapter: 0,
  });
  return series.id;
}

/** A COMPLETED chapter with `pageCount` page rows, at the given sort index. */
async function makeChapter(
  seriesId: string,
  options: { slug: string; number: number; sortIndex: number; pageCount?: number },
): Promise<string> {
  const pageCount = options.pageCount ?? 10;
  const chapter = await prisma.chapter.create({
    data: {
      seriesId,
      slug: options.slug,
      title: `Chapter ${options.number}`,
      number: options.number,
      status: "COMPLETED",
      origin: "MANUAL",
      pageCount,
      bytes: BigInt(0),
      sortIndex: options.sortIndex,
      pages: {
        create: Array.from({ length: pageCount }, (_unused, index) => ({
          index: index + 1,
          file: `${String(index + 1).padStart(3, "0")}.png`,
          bytes: 1,
        })),
      },
    },
    select: { id: true },
  });
  return chapter.id;
}

function noteBody(overrides: Partial<UpsertNoteInput> & { seriesId: string }): UpsertNoteInput {
  return {
    chapterId: null,
    pageIndex: null,
    pinX: null,
    pinY: null,
    body: "A note",
    parentId: null,
    isSpoiler: false,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Route drivers                                                              */
/* -------------------------------------------------------------------------- */

function newId(): string {
  return crypto.randomUUID();
}

async function putNote(
  user: SessionUser,
  noteId: string,
  body: UpsertNoteInput,
): Promise<Response> {
  mockCurrentUser(user);
  return putNoteRoute(
    new NextRequest(`${ORIGIN}/api/notes/${noteId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext({ id: noteId }),
  );
}

/** PUT that must succeed, returning the created/updated view. */
async function createNote(
  user: SessionUser,
  body: UpsertNoteInput,
  noteId = newId(),
): Promise<NoteView> {
  const response = await putNote(user, noteId, body);
  expect(response.status).toBe(201);
  return (await response.json()) as NoteView;
}

async function listNotes(
  user: SessionUser,
  seriesId: string,
  query: Record<string, string> = {},
): Promise<Response> {
  mockCurrentUser(user);
  const search = new URLSearchParams(query).toString();
  return listNotesRoute(
    new NextRequest(`${ORIGIN}/api/series/${seriesId}/notes${search ? `?${search}` : ""}`),
    routeContext({ id: seriesId }),
  );
}

async function listNotesOk(
  user: SessionUser,
  seriesId: string,
  query: Record<string, string> = {},
): Promise<NotesPage> {
  const response = await listNotes(user, seriesId, query);
  expect(response.status).toBe(200);
  return (await response.json()) as NotesPage;
}

async function getThread(user: SessionUser, noteId: string, reveal = false): Promise<Response> {
  mockCurrentUser(user);
  return getNoteRoute(
    new NextRequest(`${ORIGIN}/api/notes/${noteId}${reveal ? "?reveal=1" : ""}`),
    routeContext({ id: noteId }),
  );
}

async function patchNote(
  user: SessionUser,
  noteId: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  mockCurrentUser(user);
  return patchNoteRoute(
    new NextRequest(`${ORIGIN}/api/notes/${noteId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
    routeContext({ id: noteId }),
  );
}

async function deleteNote(user: SessionUser, noteId: string): Promise<Response> {
  mockCurrentUser(user);
  return deleteNoteRoute(
    new NextRequest(`${ORIGIN}/api/notes/${noteId}`, { method: "DELETE" }),
    routeContext({ id: noteId }),
  );
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("notes: upsert, list, thread", () => {
  it("creates on PUT (201), replays as an update (200) and lists top-level notes only", async () => {
    const author = await createTestUser({ displayName: "Author" });
    const seriesId = await makeSeries(author);
    const chapterId = await makeChapter(seriesId, { slug: "c1", number: 1, sortIndex: 0 });

    const noteId = newId();
    const created = await createNote(
      author,
      noteBody({ seriesId, chapterId, pageIndex: 3, pinX: 0.25, pinY: 0.5, body: "Look here" }),
      noteId,
    );
    expect(created.id).toBe(noteId);
    expect(created.pinX).toBe(0.25);
    expect(created.chapter?.sortIndex).toBe(0);
    expect(created.canEdit).toBe(true);
    expect(created.hidden).toBe(false);

    // The same id again is an edit, not a second row.
    const replay = await putNote(
      author,
      noteId,
      noteBody({ seriesId, chapterId, pageIndex: 3, body: "Look here" }),
    );
    expect(replay.status).toBe(200);
    expect(await prisma.note.count({ where: { seriesId } })).toBe(1);

    // A reply is not a list item; it is a replyCount on its parent.
    await createNote(author, noteBody({ seriesId, parentId: noteId, body: "and here" }));

    const page = await listNotesOk(author, seriesId, { chapterId, includeHidden: "1" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.id).toBe(noteId);
    expect(page.items[0]!.replyCount).toBe(1);
    expect(page.pageCounts["3"]).toBe(1);

    const threadResponse = await getThread(author, noteId);
    expect(threadResponse.status).toBe(200);
    const thread = (await threadResponse.json()) as NoteThread;
    expect(thread.replies).toHaveLength(1);
    expect(thread.replies[0]!.body).toBe("and here");
  });

  it("rejects anchors that do not belong together", async () => {
    const author = await createTestUser();
    const seriesId = await makeSeries(author);
    const otherSeriesId = await makeSeries(author, { title: "Other" });
    const chapterId = await makeChapter(seriesId, { slug: "c1", number: 1, sortIndex: 0 });
    const foreignChapterId = await makeChapter(otherSeriesId, {
      slug: "c1",
      number: 1,
      sortIndex: 0,
    });

    const foreign = await putNote(
      author,
      newId(),
      noteBody({ seriesId, chapterId: foreignChapterId, pageIndex: 1 }),
    );
    expect(foreign.status).toBe(400);

    const pastEnd = await putNote(
      author,
      newId(),
      noteBody({ seriesId, chapterId, pageIndex: 99 }),
    );
    expect(pastEnd.status).toBe(400);

    const halfPin = await putNote(
      author,
      newId(),
      noteBody({ seriesId, chapterId, pageIndex: 1, pinX: 0.5 }),
    );
    expect(halfPin.status).toBe(400);

    const pinWithoutPage = await putNote(
      author,
      newId(),
      noteBody({ seriesId, chapterId, pinX: 0.5, pinY: 0.5 }),
    );
    expect(pinWithoutPage.status).toBe(400);

    const pageWithoutChapter = await putNote(author, newId(), noteBody({ seriesId, pageIndex: 2 }));
    expect(pageWithoutChapter.status).toBe(400);
  });

  it("makes replies inherit the parent's anchor and ignore client anchors", async () => {
    const author = await createTestUser();
    const other = await createTestUser({ displayName: "Other" });
    const seriesId = await makeSeries(author);
    const chapterA = await makeChapter(seriesId, { slug: "c1", number: 1, sortIndex: 0 });
    const chapterB = await makeChapter(seriesId, { slug: "c2", number: 2, sortIndex: 1 });

    const parent = await createNote(
      author,
      noteBody({ seriesId, chapterId: chapterA, pageIndex: 4, body: "parent" }),
    );

    const reply = await createNote(
      other,
      noteBody({
        seriesId,
        chapterId: chapterB,
        pageIndex: 9,
        pinX: 0.1,
        pinY: 0.9,
        parentId: parent.id,
        body: "reply",
      }),
    );

    expect(reply.chapterId).toBe(chapterA);
    expect(reply.pageIndex).toBe(4);
    expect(reply.pinX).toBeNull();
    expect(reply.pinY).toBeNull();
  });

  it("paginates with a cursor", async () => {
    const author = await createTestUser();
    const seriesId = await makeSeries(author);
    for (const body of ["one", "two", "three"]) {
      await createNote(author, noteBody({ seriesId, body }));
    }

    const first = await listNotesOk(author, seriesId, { limit: "2" });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    // Newest first.
    expect(first.items[0]!.body).toBe("three");

    const second = await listNotesOk(author, seriesId, {
      limit: "2",
      cursor: first.nextCursor as string,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.body).toBe("one");
    expect(second.nextCursor).toBeNull();

    const ids = new Set([...first.items, ...second.items].map((item) => item.id));
    expect(ids.size).toBe(3);

    const badCursor = await listNotes(author, seriesId, { cursor: "not-a-cursor" });
    expect(badCursor.status).toBe(400);
  });
});

describe("notes: authorization", () => {
  it("hides a private series' notes from everyone else with a 404", async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const seriesId = await makeSeries(owner, { visibility: "PRIVATE" });
    const note = await createNote(owner, noteBody({ seriesId, body: "mine" }));

    expect((await listNotes(stranger, seriesId)).status).toBe(404);
    expect((await getThread(stranger, note.id)).status).toBe(404);
    expect((await deleteNote(stranger, note.id)).status).toBe(404);

    const write = await putNote(stranger, newId(), noteBody({ seriesId, body: "intruding" }));
    expect(write.status).toBe(404);
  });

  it("lets only the author edit, and the author or an admin delete", async () => {
    const author = await createTestUser();
    const member = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    const seriesId = await makeSeries(author);

    const note = await createNote(author, noteBody({ seriesId, body: "original" }));

    expect((await patchNote(member, note.id, { body: "hijacked" })).status).toBe(403);
    expect((await patchNote(admin, note.id, { body: "moderated" })).status).toBe(403);
    expect((await putNote(member, note.id, noteBody({ seriesId, body: "hijacked" }))).status).toBe(
      403,
    );

    const edited = await patchNote(author, note.id, { body: "edited" });
    expect(edited.status).toBe(200);
    const editedView = (await edited.json()) as NoteView;
    expect(editedView.body).toBe("edited");
    expect(editedView.editedAt).not.toBeNull();

    expect((await deleteNote(member, note.id)).status).toBe(403);
    expect((await deleteNote(admin, note.id)).status).toBe(204);

    const row = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it("keeps a deleted note in its thread as an empty placeholder", async () => {
    const author = await createTestUser();
    const other = await createTestUser();
    const seriesId = await makeSeries(author);

    const parent = await createNote(author, noteBody({ seriesId, body: "parent" }));
    await createNote(other, noteBody({ seriesId, parentId: parent.id, body: "reply" }));
    expect((await deleteNote(author, parent.id)).status).toBe(204);

    const page = await listNotesOk(author, seriesId);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.body).toBe("");
    expect(page.items[0]!.hidden).toBe(false);
    expect(page.items[0]!.canEdit).toBe(false);

    const thread = (await (await getThread(author, parent.id)).json()) as NoteThread;
    expect(thread.replies[0]!.body).toBe("reply");
  });

  it("drops a deleted note with no replies from the list", async () => {
    const author = await createTestUser();
    const seriesId = await makeSeries(author);
    const note = await createNote(author, noteBody({ seriesId, body: "gone soon" }));
    await deleteNote(author, note.id);

    const page = await listNotesOk(author, seriesId);
    expect(page.items).toHaveLength(0);
  });
});

describe("notes: notifications", () => {
  it("notifies the parent author of a reply, once, and never yourself", async () => {
    const author = await createTestUser({ displayName: "Author" });
    const replier = await createTestUser({ displayName: "Replier" });
    const seriesId = await makeSeries(author);
    const chapterId = await makeChapter(seriesId, { slug: "c1", number: 1, sortIndex: 0 });

    const parent = await createNote(
      author,
      noteBody({ seriesId, chapterId, pageIndex: 2, body: "parent" }),
    );

    // The author replying to their own note notifies nobody.
    await createNote(author, noteBody({ seriesId, parentId: parent.id, body: "self reply" }));
    expect(await prisma.notification.count({ where: { type: "NOTE_REPLY" } })).toBe(0);

    const replyId = newId();
    await createNote(
      replier,
      noteBody({ seriesId, parentId: parent.id, body: "someone else" }),
      replyId,
    );

    const notifications = await prisma.notification.findMany({ where: { type: "NOTE_REPLY" } });
    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification.userId).toBe(author.id);
    expect(notification.noteId).toBe(replyId);
    expect(notification.dedupeKey).toBe(`note-reply:${replyId}`);
    expect(notification.link).toBe(
      `/read?series=${seriesId}&chapter=${chapterId}&page=2&notes=1&note=${replyId}`,
    );

    // A replay of the same write must not notify a second time.
    const replay = await putNote(
      replier,
      replyId,
      noteBody({ seriesId, parentId: parent.id, body: "someone else" }),
    );
    expect(replay.status).toBe(200);
    expect(await prisma.notification.count({ where: { type: "NOTE_REPLY" } })).toBe(1);
  });

  it("notifies @displayName mentions and links series-level notes to the series page", async () => {
    const author = await createTestUser({ displayName: "Author" });
    const ann = await createTestUser({ displayName: "Ann Marie" });
    await createTestUser({ displayName: "Ann" });
    const seriesId = await makeSeries(author);

    const note = await createNote(
      author,
      noteBody({ seriesId, body: "what did @Ann Marie think of this?" }),
    );

    const mentions = await prisma.notification.findMany({ where: { type: "NOTE_MENTION" } });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.userId).toBe(ann.id);
    expect(mentions[0]!.link).toBe(`/series/${seriesId}`);
    expect(mentions[0]!.noteId).toBe(note.id);
  });

  it("does not send a mention notification twice to the reply's parent author", async () => {
    const author = await createTestUser({ displayName: "Author" });
    const replier = await createTestUser({ displayName: "Replier" });
    const seriesId = await makeSeries(author);
    const parent = await createNote(author, noteBody({ seriesId, body: "parent" }));

    await createNote(replier, noteBody({ seriesId, parentId: parent.id, body: "thanks @Author" }));

    expect(await prisma.notification.count({ where: { type: "NOTE_REPLY" } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: "NOTE_MENTION" } })).toBe(0);
  });
});

describe("notes: spoiler gating", () => {
  it("hides notes past your progress until you read the chapter, and reveals on request", async () => {
    const author = await createTestUser({ displayName: "Author" });
    const reader = await createTestUser({ displayName: "Reader" });
    const seriesId = await makeSeries(author);
    const chapterOne = await makeChapter(seriesId, { slug: "c1", number: 1, sortIndex: 0 });
    const chapterTwo = await makeChapter(seriesId, { slug: "c2", number: 2, sortIndex: 1 });

    const early = await createNote(
      author,
      noteBody({ seriesId, chapterId: chapterOne, pageIndex: 2, body: "early note" }),
    );
    const late = await createNote(
      author,
      noteBody({ seriesId, chapterId: chapterTwo, pageIndex: 5, body: "late note" }),
    );
    const flagged = await createNote(
      author,
      noteBody({
        seriesId,
        chapterId: chapterOne,
        pageIndex: 1,
        body: "flagged note",
        isSpoiler: true,
      }),
    );

    // The author always sees their own notes in full.
    const authorView = await listNotesOk(author, seriesId, { includeHidden: "1" });
    expect(authorView.items.every((item) => item.hidden === false)).toBe(true);

    // A reader who has read nothing: everything is gated.
    const cold = await listNotesOk(reader, seriesId, { includeHidden: "1" });
    expect(cold.items).toHaveLength(3);
    expect(cold.items.every((item) => item.hidden && item.body === "")).toBe(true);

    // Without includeHidden, progress-gated notes are dropped entirely, while
    // an author-flagged spoiler still arrives (shielded).
    const filtered = await listNotesOk(reader, seriesId);
    expect(filtered.items.map((item) => item.id)).toEqual([flagged.id]);

    // Reading chapter one reveals both of its notes except the flagged one.
    await prisma.chapterRead.create({
      data: { userId: reader.id, seriesId, chapterId: chapterOne },
    });
    const afterRead = await listNotesOk(reader, seriesId, { includeHidden: "1" });
    const byId = new Map(afterRead.items.map((item) => [item.id, item]));
    expect(byId.get(early.id)!.hidden).toBe(false);
    expect(byId.get(early.id)!.body).toBe("early note");
    expect(byId.get(late.id)!.hidden).toBe(true);
    expect(byId.get(flagged.id)!.hidden).toBe(true);

    // A reading position part-way into chapter two reveals the pages behind it.
    await prisma.readingPosition.create({
      data: { userId: reader.id, seriesId, chapterId: chapterTwo, pageIndex: 4 },
    });
    const atPage5 = await listNotesOk(reader, seriesId, { includeHidden: "1" });
    expect(atPage5.items.find((item) => item.id === late.id)!.hidden).toBe(false);

    await prisma.readingPosition.update({
      where: { userId_seriesId: { userId: reader.id, seriesId } },
      data: { pageIndex: 2 },
    });
    const atPage3 = await listNotesOk(reader, seriesId, { includeHidden: "1" });
    expect(atPage3.items.find((item) => item.id === late.id)!.hidden).toBe(true);

    // reveal=1 hands back the body the shield was covering.
    const shielded = (await (await getThread(reader, late.id)).json()) as NoteThread;
    expect(shielded.note.hidden).toBe(true);
    expect(shielded.note.body).toBe("");

    const revealed = (await (await getThread(reader, late.id, true)).json()) as NoteThread;
    expect(revealed.note.hidden).toBe(true);
    expect(revealed.note.body).toBe("late note");
  });

  it("bypasses the gate entirely for a showSpoilers viewer", async () => {
    const author = await createTestUser();
    const reader = await createTestUser({ showSpoilers: true });
    const seriesId = await makeSeries(author);
    const chapterId = await makeChapter(seriesId, { slug: "c1", number: 1, sortIndex: 0 });

    await createNote(
      author,
      noteBody({
        seriesId,
        chapterId,
        pageIndex: 9,
        body: "everything is revealed",
        isSpoiler: true,
      }),
    );

    const page = await listNotesOk(reader, seriesId);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.hidden).toBe(false);
    expect(page.items[0]!.body).toBe("everything is revealed");
  });

  it("never gates a series-level note", async () => {
    const author = await createTestUser();
    const reader = await createTestUser();
    const seriesId = await makeSeries(author);
    await makeChapter(seriesId, { slug: "c1", number: 1, sortIndex: 0 });

    await createNote(author, noteBody({ seriesId, body: "about the series" }));

    const page = await listNotesOk(reader, seriesId);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.hidden).toBe(false);
  });
});

describe("notes: summary", () => {
  it("counts notes per chapter and at series level", async () => {
    const author = await createTestUser();
    const seriesId = await makeSeries(author);
    const chapterOne = await makeChapter(seriesId, { slug: "c1", number: 1, sortIndex: 0 });
    const chapterTwo = await makeChapter(seriesId, { slug: "c2", number: 2, sortIndex: 1 });

    await createNote(author, noteBody({ seriesId, body: "series level" }));
    const first = await createNote(
      author,
      noteBody({ seriesId, chapterId: chapterOne, pageIndex: 1, body: "one" }),
    );
    await createNote(author, noteBody({ seriesId, chapterId: chapterOne, body: "chapter level" }));
    await createNote(
      author,
      noteBody({ seriesId, chapterId: chapterTwo, pageIndex: 2, body: "two" }),
    );
    // Replies count towards the totals; deleted notes do not.
    await createNote(author, noteBody({ seriesId, parentId: first.id, body: "reply" }));
    const doomed = await createNote(
      author,
      noteBody({ seriesId, chapterId: chapterTwo, pageIndex: 3, body: "doomed" }),
    );
    await deleteNote(author, doomed.id);

    mockCurrentUser(author);
    const response = await summaryRoute(
      new NextRequest(`${ORIGIN}/api/series/${seriesId}/notes/summary`),
      routeContext({ id: seriesId }),
    );
    expect(response.status).toBe(200);
    const summary = (await response.json()) as NotesSummary;

    expect(summary.total).toBe(5);
    expect(summary.seriesLevel).toBe(1);
    const counts = new Map(summary.byChapter.map((entry) => [entry.chapterId, entry.count]));
    expect(counts.get(chapterOne)).toBe(3);
    expect(counts.get(chapterTwo)).toBe(1);
  });
});

describe("notes: offline sync", () => {
  it("replays a queued note idempotently", async () => {
    const author = await createTestUser();
    const seriesId = await makeSeries(author);
    const chapterId = await makeChapter(seriesId, { slug: "c1", number: 1, sortIndex: 0 });

    const noteId = newId();
    const op = {
      noteId,
      at: new Date().toISOString(),
      note: {
        seriesId,
        chapterId,
        pageIndex: 3,
        pinX: 0.5,
        pinY: 0.5,
        body: "written offline",
        parentId: null,
        isSpoiler: false,
      } as Record<string, unknown>,
    };

    expect(await applyNoteSyncOp(author, op)).toEqual({ ok: true });
    expect(await applyNoteSyncOp(author, op)).toEqual({ ok: true });

    const rows = await prisma.note.findMany({ where: { seriesId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(noteId);
    expect(rows[0]!.body).toBe("written offline");
    // A replay of the identical body is not an edit.
    expect(rows[0]!.editedAt).toBeNull();
  });

  it("reports a malformed or rejected op instead of throwing", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const seriesId = await makeSeries(author, { visibility: "PRIVATE" });

    const invalid = await applyNoteSyncOp(author, {
      noteId: newId(),
      at: new Date().toISOString(),
      note: { seriesId, body: "" },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("Invalid note");

    const forbidden = await applyNoteSyncOp(stranger, {
      noteId: newId(),
      at: new Date().toISOString(),
      note: {
        seriesId,
        chapterId: null,
        pageIndex: null,
        pinX: null,
        pinY: null,
        body: "not mine",
        parentId: null,
        isSpoiler: false,
      },
    });
    expect(forbidden.ok).toBe(false);
    expect(await prisma.note.count()).toBe(0);
  });
});
