/**
 * Reading state: position upserts, the "last page finishes the chapter" rule,
 * the library-entry bump that goes with it, and the continue-reading rail.
 */
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { PUT as putReadRoute } from "@/app/api/chapters/[id]/read/route";
import { GET as continueRoute } from "@/app/api/library/continue/route";
import { PUT as putPositionRoute } from "@/app/api/series/[id]/position/route";
import type { SessionUser } from "@/lib/auth/types";
import type {
  ChapterListItem,
  ContinueReadingResponse,
  ReadingPositionView,
} from "@/lib/contracts";
import { resetEnvCache } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { toSortTitle } from "@/lib/text";
import { createLocalChapter } from "./chapters";
import { chapterDir } from "./store";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
const DATA_ROOT = path.resolve(process.cwd(), "data", `test-content-reading-${process.pid}`);

function request(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function seedSeries(
  creator: SessionUser,
  overrides: { title?: string; visibility?: "SHARED" | "PRIVATE" } = {},
): Promise<string> {
  const title = overrides.title ?? "Reading Test";
  const row = await prisma.series.create({
    data: {
      title,
      sortTitle: toSortTitle(title),
      visibility: overrides.visibility ?? "SHARED",
      createdById: creator.id,
    },
    select: { id: true },
  });
  return row.id;
}

async function addChapter(
  seriesId: string,
  slug: string,
  options: { number?: number | null; pages?: number } = {},
): Promise<string> {
  const dir = chapterDir(seriesId, slug);
  await mkdir(dir, { recursive: true });
  const pages: { path: string; index: number }[] = [];
  for (let index = 1; index <= (options.pages ?? 2); index += 1) {
    const png = await sharp({
      create: { width: 10, height: 14, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const file = path.join(dir, `${String(index).padStart(3, "0")}.png`);
    await writeFile(file, png);
    pages.push({ path: file, index });
  }
  const created = await createLocalChapter({
    seriesId,
    slug,
    title: slug,
    number: options.number ?? null,
    volume: null,
    origin: "MANUAL",
    pages,
  });
  return created.chapterId;
}

function putPosition(seriesId: string, body: unknown): Promise<Response> {
  return putPositionRoute(
    request(`/api/series/${seriesId}/position`, "PUT", body),
    routeContext({ id: seriesId }),
  );
}

function putRead(chapterId: string, read: boolean): Promise<Response> {
  return putReadRoute(
    request(`/api/chapters/${chapterId}/read`, "PUT", { read }),
    routeContext({ id: chapterId }),
  );
}

beforeAll(() => {
  process.env.DATA_ROOT = DATA_ROOT;
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
  await rm(DATA_ROOT, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(DATA_ROOT, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

describe("PUT /api/series/:id/position", () => {
  it("upserts the position without marking the chapter read mid-chapter", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const seriesId = await seedSeries(user);
    const chapterId = await addChapter(seriesId, "chapter-1", { number: 1, pages: 3 });

    const response = await putPosition(seriesId, { chapterId, pageIndex: 1 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadingPositionView;
    expect(body).toMatchObject({ chapterId, pageIndex: 1 });

    expect(await prisma.chapterRead.count({ where: { userId: user.id } })).toBe(0);

    // Second call updates the same row (unique on user+series).
    await putPosition(seriesId, { chapterId, pageIndex: 2 });
    const rows = await prisma.readingPosition.findMany({ where: { userId: user.id, seriesId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pageIndex).toBe(2);
  });

  it("marks the chapter read on the last page and starts a library entry", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const seriesId = await seedSeries(user);
    const chapterId = await addChapter(seriesId, "chapter-3", { number: 3, pages: 3 });

    await putPosition(seriesId, { chapterId, pageIndex: 2 });

    const read = await prisma.chapterRead.findFirst({ where: { userId: user.id, chapterId } });
    expect(read).not.toBeNull();
    const entry = await prisma.libraryEntry.findUniqueOrThrow({
      where: { userId_seriesId: { userId: user.id, seriesId } },
    });
    expect(entry.status).toBe("READING");
    expect(entry.currentChapter).toBe(3);
  });

  it("advances an existing entry forwards only and lifts PLAN_TO_READ", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const seriesId = await seedSeries(user);
    await prisma.libraryEntry.create({
      data: { userId: user.id, seriesId, status: "PLAN_TO_READ", currentChapter: 5 },
    });
    const behind = await addChapter(seriesId, "chapter-2", { number: 2, pages: 1 });
    const ahead = await addChapter(seriesId, "chapter-9", { number: 9, pages: 1 });

    await putPosition(seriesId, { chapterId: behind, pageIndex: 0 });
    let entry = await prisma.libraryEntry.findUniqueOrThrow({
      where: { userId_seriesId: { userId: user.id, seriesId } },
    });
    expect(entry.status).toBe("READING");
    expect(entry.currentChapter).toBe(5);

    await putPosition(seriesId, { chapterId: ahead, pageIndex: 0 });
    entry = await prisma.libraryEntry.findUniqueOrThrow({
      where: { userId_seriesId: { userId: user.id, seriesId } },
    });
    expect(entry.currentChapter).toBe(9);
  });

  it("rejects a chapter from another series and a series the user cannot see", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    mockCurrentUser(owner);
    const seriesId = await seedSeries(owner);
    const otherSeriesId = await seedSeries(owner, { title: "Other" });
    const foreign = await addChapter(otherSeriesId, "chapter-1", { number: 1, pages: 1 });

    const mismatched = await putPosition(seriesId, { chapterId: foreign, pageIndex: 0 });
    expect(mismatched.status).toBe(400);

    await prisma.series.update({ where: { id: seriesId }, data: { visibility: "PRIVATE" } });
    mockCurrentUser(other);
    const hidden = await putPosition(seriesId, { chapterId: null, pageIndex: 0 });
    expect(hidden.status).toBe(404);
  });
});

describe("PUT /api/chapters/:id/read", () => {
  it("marks read and unread, and answers with the chapter item", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const seriesId = await seedSeries(user);
    const chapterId = await addChapter(seriesId, "chapter-1", { number: 1, pages: 2 });

    const marked = await putRead(chapterId, true);
    expect(marked.status).toBe(200);
    const item = (await marked.json()) as ChapterListItem;
    expect(item).toMatchObject({ id: chapterId, read: true });
    expect(item.readAt).not.toBeNull();

    // Idempotent: marking twice keeps one row.
    await putRead(chapterId, true);
    expect(await prisma.chapterRead.count({ where: { userId: user.id, chapterId } })).toBe(1);

    const cleared = await putRead(chapterId, false);
    const clearedItem = (await cleared.json()) as ChapterListItem;
    expect(clearedItem.read).toBe(false);
    expect(await prisma.chapterRead.count({ where: { userId: user.id, chapterId } })).toBe(0);
    // The manual counter is not rolled back by un-marking one chapter.
    const entry = await prisma.libraryEntry.findUniqueOrThrow({
      where: { userId_seriesId: { userId: user.id, seriesId } },
    });
    expect(entry.currentChapter).toBe(1);
  });
});

describe("GET /api/library/continue", () => {
  it("returns the most recent positions first, only for visible series", async () => {
    const user = await createTestUser();
    const stranger = await createTestUser();
    mockCurrentUser(user);

    const oldSeries = await seedSeries(user, { title: "Older" });
    const newSeries = await seedSeries(user, { title: "Newer" });
    const chapterId = await addChapter(newSeries, "chapter-1", { number: 1, pages: 2 });

    await prisma.readingPosition.create({
      data: {
        userId: user.id,
        seriesId: oldSeries,
        pageIndex: 4,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      },
    });
    await prisma.readingPosition.create({
      data: {
        userId: user.id,
        seriesId: newSeries,
        chapterId,
        pageIndex: 1,
        updatedAt: new Date("2024-06-01T00:00:00.000Z"),
      },
    });
    // Someone else's position never shows up here.
    const strangerSeries = await seedSeries(stranger, { title: "Theirs" });
    await prisma.readingPosition.create({
      data: { userId: stranger.id, seriesId: strangerSeries, pageIndex: 0 },
    });

    const response = await continueRoute(request("/api/library/continue", "GET"), routeContext({}));
    expect(response.status).toBe(200);
    const body = (await response.json()) as ContinueReadingResponse;

    expect(body.items.map((item) => item.series.title)).toEqual(["Newer", "Older"]);
    expect(body.items[0]?.chapter).toMatchObject({ id: chapterId, pageCount: 2 });
    expect(body.items[0]?.pageIndex).toBe(1);
    expect(body.items[1]?.chapter).toBeNull();
  });

  it("honours the limit and hides other people's private series", async () => {
    const user = await createTestUser();
    const owner = await createTestUser();
    mockCurrentUser(user);

    const visible = await seedSeries(user, { title: "Mine" });
    const hidden = await seedSeries(owner, { title: "Secret", visibility: "PRIVATE" });
    await prisma.readingPosition.create({
      data: { userId: user.id, seriesId: visible, pageIndex: 0 },
    });
    await prisma.readingPosition.create({
      data: { userId: user.id, seriesId: hidden, pageIndex: 0 },
    });

    const all = await continueRoute(request("/api/library/continue", "GET"), routeContext({}));
    const body = (await all.json()) as ContinueReadingResponse;
    expect(body.items.map((item) => item.series.title)).toEqual(["Mine"]);

    const limited = await continueRoute(
      request("/api/library/continue?limit=1", "GET"),
      routeContext({}),
    );
    expect(((await limited.json()) as ContinueReadingResponse).items).toHaveLength(1);
  });
});
