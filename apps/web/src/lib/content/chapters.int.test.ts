/**
 * Chapter service + chapter/page routes against a real database and a real
 * DATA_ROOT: local chapter creation, listing, detail with prev/next, editing,
 * deletion, the per-request authorization checks and the image route.
 */
import path from "node:path";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import {
  DELETE as deleteChapterRoute,
  GET as getChapterRoute,
  PATCH as patchChapterRoute,
} from "@/app/api/chapters/[id]/route";
import { GET as getPageImageRoute } from "@/app/api/pages/[id]/image/route";
import { GET as getChaptersRoute } from "@/app/api/series/[id]/chapters/route";
import type { SessionUser } from "@/lib/auth/types";
import type { ChapterDetail, ChapterListResponse } from "@/lib/contracts";
import { resetEnvCache } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { toSortTitle } from "@/lib/text";
import { createLocalChapter } from "./chapters";
import { chapterDir, chapterFilePath } from "./store";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
const DATA_ROOT = path.resolve(process.cwd(), "data", `test-content-chapters-${process.pid}`);

interface ApiErrorBody {
  error: { code: string; message: string };
}

function request(url: string, method: string, body?: unknown, headers?: HeadersInit): NextRequest {
  return new NextRequest(`${ORIGIN}${url}`, {
    method,
    ...(body === undefined
      ? { ...(headers ? { headers } : {}) }
      : {
          headers: { "content-type": "application/json", ...(headers as Record<string, string>) },
          body: JSON.stringify(body),
        }),
  });
}

async function seedSeries(
  creator: SessionUser,
  overrides: { title?: string; visibility?: "SHARED" | "PRIVATE" } = {},
): Promise<string> {
  const title = overrides.title ?? "Chapter Test";
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

/** Write `count` PNGs into the chapter directory and return their paths. */
async function writeChapterFiles(
  seriesId: string,
  slug: string,
  count: number,
): Promise<{ path: string; index: number }[]> {
  const dir = chapterDir(seriesId, slug);
  await mkdir(dir, { recursive: true });
  const pages: { path: string; index: number }[] = [];
  for (let index = 1; index <= count; index += 1) {
    const png = await sharp({
      create: { width: 20, height: 30, channels: 3, background: { r: 5 * index, g: 9, b: 11 } },
    })
      .png()
      .toBuffer();
    const file = path.join(dir, `${String(index).padStart(3, "0")}.png`);
    await writeFile(file, png);
    pages.push({ path: file, index });
  }
  return pages;
}

async function addChapter(
  seriesId: string,
  slug: string,
  options: { title?: string; number?: number | null; pages?: number } = {},
): Promise<string> {
  const files = await writeChapterFiles(seriesId, slug, options.pages ?? 2);
  const created = await createLocalChapter({
    seriesId,
    slug,
    title: options.title ?? slug,
    number: options.number ?? null,
    volume: null,
    origin: "MANUAL",
    pages: files,
  });
  return created.chapterId;
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

describe("createLocalChapter", () => {
  it("creates the chapter, its pages and the series counters", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const files = await writeChapterFiles(seriesId, "manual-1", 3);

    const created = await createLocalChapter({
      seriesId,
      slug: "manual-1",
      title: "Uploaded chapter",
      number: 4.5,
      volume: "2",
      origin: "MANUAL",
      pages: files,
    });

    expect(created.pageCount).toBe(3);
    expect(created.bytes).toBeGreaterThan(0);

    const chapter = await prisma.chapter.findUniqueOrThrow({
      where: { id: created.chapterId },
      include: { pages: { orderBy: { index: "asc" } } },
    });
    expect(chapter).toMatchObject({
      slug: "manual-1",
      title: "Uploaded chapter",
      number: 4.5,
      volume: "2",
      origin: "MANUAL",
      status: "COMPLETED",
      pageCount: 3,
      sortIndex: 0,
    });
    expect(chapter.downloadedAt).not.toBeNull();
    expect(Number(chapter.bytes)).toBe(created.bytes);
    expect(chapter.pages.map((page) => page.file)).toEqual(["001.png", "002.png", "003.png"]);
    expect(chapter.pages[0]).toMatchObject({ width: 20, height: 30, mime: "image/png" });
    expect(chapter.pages[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const series = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } });
    expect(series.chapterCount).toBe(1);
    expect(series.lastChapterAt).not.toBeNull();
  });

  it("refuses a duplicate slug, an empty page list and files outside the chapter", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const files = await writeChapterFiles(seriesId, "manual-1", 1);
    await createLocalChapter({
      seriesId,
      slug: "manual-1",
      title: "One",
      number: null,
      volume: null,
      origin: "MANUAL",
      pages: files,
    });

    await expect(
      createLocalChapter({
        seriesId,
        slug: "manual-1",
        title: "Again",
        number: null,
        volume: null,
        origin: "MANUAL",
        pages: files,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      createLocalChapter({
        seriesId,
        slug: "manual-2",
        title: "Empty",
        number: null,
        volume: null,
        origin: "PDF",
        pages: [],
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      createLocalChapter({
        seriesId,
        slug: "manual-3",
        title: "Elsewhere",
        number: null,
        volume: null,
        origin: "PDF",
        pages: [{ path: path.join(DATA_ROOT, "outside.png"), index: 1 }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("GET /api/series/:id/chapters", () => {
  it("lists chapters in reading order with read state and position", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const seriesId = await seedSeries(user);
    const first = await addChapter(seriesId, "chapter-1", { number: 1 });
    await addChapter(seriesId, "chapter-2", { number: 2 });
    await prisma.chapterRead.create({ data: { userId: user.id, seriesId, chapterId: first } });
    await prisma.readingPosition.create({
      data: { userId: user.id, seriesId, chapterId: first, pageIndex: 1 },
    });

    const response = await getChaptersRoute(
      request(`/api/series/${seriesId}/chapters`, "GET"),
      routeContext({ id: seriesId }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ChapterListResponse;

    expect(body.series).toMatchObject({ id: seriesId, canEdit: true });
    expect(body.chapters.map((chapter) => chapter.slug)).toEqual(["chapter-1", "chapter-2"]);
    expect(body.chapters[0]?.read).toBe(true);
    expect(body.chapters[0]?.readAt).not.toBeNull();
    expect(body.chapters[1]?.read).toBe(false);
    expect(body.readCount).toBe(1);
    expect(body.readableCount).toBe(2);
    expect(body.position).toMatchObject({ chapterId: first, pageIndex: 1 });
  });

  it("hides a private series from everyone but its creator", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const seriesId = await seedSeries(owner, { visibility: "PRIVATE" });
    await addChapter(seriesId, "chapter-1", { number: 1 });

    mockCurrentUser(other);
    const response = await getChaptersRoute(
      request(`/api/series/${seriesId}/chapters`, "GET"),
      routeContext({ id: seriesId }),
    );
    expect(response.status).toBe(404);
  });
});

describe("GET/PATCH/DELETE /api/chapters/:id", () => {
  it("returns pages plus the neighbouring readable chapters", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const seriesId = await seedSeries(user);
    const first = await addChapter(seriesId, "chapter-1", { number: 1 });
    const second = await addChapter(seriesId, "chapter-2", { number: 2 });
    const third = await addChapter(seriesId, "chapter-3", { number: 3 });
    // An unreadable chapter is skipped by prev/next.
    await prisma.chapter.update({ where: { id: third }, data: { status: "FAILED" } });
    const fourth = await addChapter(seriesId, "chapter-4", { number: 4 });

    const response = await getChapterRoute(
      request(`/api/chapters/${second}`, "GET"),
      routeContext({ id: second }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ChapterDetail;

    expect(body.seriesId).toBe(seriesId);
    expect(body.seriesTitle).toBe("Chapter Test");
    expect(body.pages).toHaveLength(2);
    expect(body.pages[0]).toMatchObject({ index: 1, width: 20, height: 30, mime: "image/png" });
    expect(body.pages[0]?.url).toBe(`/api/pages/${body.pages[0]?.id}/image`);
    expect(body.prev?.id).toBe(first);
    expect(body.next?.id).toBe(fourth);
  });

  it("renumbers a chapter and reorders the series", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const seriesId = await seedSeries(user);
    const first = await addChapter(seriesId, "chapter-1", { number: 1 });
    const second = await addChapter(seriesId, "chapter-2", { number: 2 });

    const response = await patchChapterRoute(
      request(`/api/chapters/${first}`, "PATCH", { number: 3, title: "Moved" }),
      routeContext({ id: first }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ChapterDetail;
    expect(body.title).toBe("Moved");
    expect(body.number).toBe(3);

    const chapters = await prisma.chapter.findMany({
      where: { seriesId },
      orderBy: { sortIndex: "asc" },
      select: { id: true },
    });
    expect(chapters.map((chapter) => chapter.id)).toEqual([second, first]);
  });

  it("lets a viewer read but not edit someone else's series", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const seriesId = await seedSeries(owner);
    const chapterId = await addChapter(seriesId, "chapter-1", { number: 1 });

    mockCurrentUser(other);
    const read = await getChapterRoute(
      request(`/api/chapters/${chapterId}`, "GET"),
      routeContext({ id: chapterId }),
    );
    expect(read.status).toBe(200);

    const edit = await patchChapterRoute(
      request(`/api/chapters/${chapterId}`, "PATCH", { title: "Nope" }),
      routeContext({ id: chapterId }),
    );
    expect(edit.status).toBe(403);
    expect(((await edit.json()) as ApiErrorBody).error.code).toBe("FORBIDDEN");

    const removed = await deleteChapterRoute(
      request(`/api/chapters/${chapterId}`, "DELETE"),
      routeContext({ id: chapterId }),
    );
    expect(removed.status).toBe(403);
  });

  it("deletes the row, the files and updates the counters", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const seriesId = await seedSeries(user);
    const chapterId = await addChapter(seriesId, "chapter-1", { number: 1 });
    await addChapter(seriesId, "chapter-2", { number: 2 });

    const response = await deleteChapterRoute(
      request(`/api/chapters/${chapterId}`, "DELETE"),
      routeContext({ id: chapterId }),
    );
    expect(response.status).toBe(204);

    expect(await prisma.chapter.findUnique({ where: { id: chapterId } })).toBeNull();
    expect(await prisma.page.count({ where: { chapterId } })).toBe(0);
    await expect(stat(chapterDir(seriesId, "chapter-1"))).rejects.toThrow();

    const series = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } });
    expect(series.chapterCount).toBe(1);
    const remaining = await prisma.chapter.findMany({ where: { seriesId } });
    expect(remaining[0]?.sortIndex).toBe(0);
  });
});

describe("GET /api/pages/:id/image", () => {
  async function seedPage(): Promise<{ user: SessionUser; seriesId: string; pageId: string }> {
    const user = await createTestUser();
    mockCurrentUser(user);
    const seriesId = await seedSeries(user);
    await addChapter(seriesId, "chapter-1", { number: 1, pages: 1 });
    const page = await prisma.page.findFirstOrThrow({ select: { id: true } });
    return { user, seriesId, pageId: page.id };
  }

  function getImage(pageId: string, headers?: Record<string, string>): Promise<Response> {
    return getPageImageRoute(
      request(`/api/pages/${pageId}/image`, "GET", undefined, headers),
      routeContext({ id: pageId }),
    );
  }

  it("serves the bytes with immutable cache headers", async () => {
    const { pageId } = await seedPage();
    const response = await getImage(pageId);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    // PNG magic number: the real file, not an error page.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("answers 304 for a matching ETag", async () => {
    const { pageId } = await seedPage();
    const first = await getImage(pageId);
    const etag = first.headers.get("etag") ?? "";

    const second = await getImage(pageId, { "if-none-match": etag });
    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  });

  it("is a 404 when the file is gone and a 404 for a private series", async () => {
    const { seriesId, pageId } = await seedPage();
    const page = await prisma.page.findUniqueOrThrow({ where: { id: pageId } });
    await rm(chapterFilePath(seriesId, "chapter-1", page.file), { force: true });
    expect((await getImage(pageId)).status).toBe(404);

    await prisma.series.update({ where: { id: seriesId }, data: { visibility: "PRIVATE" } });
    mockCurrentUser(await createTestUser());
    expect((await getImage(pageId)).status).toBe(404);
  });
});
