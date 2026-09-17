/**
 * End-to-end content pipeline: chunked upload -> import route -> job runner ->
 * MANUAL_UPLOAD handler -> the real `createLocalChapter` -> chapter/page rows
 * and files on disk -> chapter list/detail/image routes -> reading
 * position/read state.
 *
 * Every module in the chain is real. The only mock is `@/lib/auth/session`
 * (the project's standard way of driving route handlers as a given user, per
 * test/factories.ts `mockCurrentUser`) — `@/lib/content/chapters` is *not*
 * mocked here, unlike src/lib/jobs/handlers/manual-upload.int.test.ts, because
 * the point of this file is to prove the seam between the job handler and the
 * content-core service actually holds end to end.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { buildZip } from "../../../test/zip-fixture";

import {
  GET as getChapterRoute,
  DELETE as deleteChapterRoute,
} from "@/app/api/chapters/[id]/route";
import { PUT as putChapterReadRoute } from "@/app/api/chapters/[id]/read/route";
import { GET as getJobRoute } from "@/app/api/jobs/[id]/route";
import { GET as getPageImageRoute } from "@/app/api/pages/[id]/image/route";
import { POST as importRoute } from "@/app/api/series/[id]/chapters/import/route";
import { GET as getChaptersRoute } from "@/app/api/series/[id]/chapters/route";
import { PUT as putPositionRoute } from "@/app/api/series/[id]/position/route";
import { PUT as putChunkRoute } from "@/app/api/uploads/[id]/chunks/[index]/route";
import { POST as completeUploadRoute } from "@/app/api/uploads/[id]/complete/route";
import { POST as createUploadRoute } from "@/app/api/uploads/route";

import type { SessionUser } from "@/lib/auth/types";
import { chapterDir } from "@/lib/content/store";
import type {
  ChapterDetail,
  ChapterListItem,
  ChapterListResponse,
  EnqueuedJobResponse,
  JobView,
  ReadingPositionView,
  UploadSessionView,
} from "@/lib/contracts/content";
import { resetEnvCache } from "@/lib/env";
// Registers every job handler (MANUAL_UPLOAD included) as a side effect.
import "@/lib/jobs/handlers";
import { processJobsUntilIdle, stopJobRunner } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { createSeries } from "@/lib/series/service";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

let dataRoot: string;

beforeAll(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-pipeline-"));
  process.env.DATA_ROOT = dataRoot;
  resetEnvCache();
});

afterAll(() => {
  stopJobRunner();
  rmSync(dataRoot, { recursive: true, force: true });
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function makePng(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

/** `BodyInit` in this lib configuration does not name Uint8Array/Buffer; undici takes it. */
function asBody(data: Uint8Array): BodyInit {
  return data as unknown as BodyInit;
}

async function createUploadSessionHttp(
  user: SessionUser,
  body: { filename: string; size: number; mime?: string },
): Promise<UploadSessionView> {
  mockCurrentUser(user);
  const response = await createUploadRoute(
    new NextRequest(`${ORIGIN}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext({}),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as UploadSessionView;
}

/** Drive the real chunked-upload routes end to end for a small (single-chunk) file. */
async function uploadWholeFile(
  user: SessionUser,
  filename: string,
  data: Buffer,
  mime?: string,
): Promise<string> {
  const session = await createUploadSessionHttp(user, { filename, size: data.length, mime });
  expect(session.chunkCount).toBe(1);

  mockCurrentUser(user);
  const chunkResponse = await putChunkRoute(
    new NextRequest(`${ORIGIN}/api/uploads/${session.id}/chunks/0`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: asBody(data),
    }),
    routeContext({ id: session.id, index: "0" }),
  );
  expect(chunkResponse.status).toBe(200);

  mockCurrentUser(user);
  const completeResponse = await completeUploadRoute(
    new NextRequest(`${ORIGIN}/api/uploads/${session.id}/complete`, { method: "POST" }),
    routeContext({ id: session.id }),
  );
  expect(completeResponse.status).toBe(200);
  const completed = (await completeResponse.json()) as UploadSessionView;
  expect(completed.complete).toBe(true);
  return session.id;
}

async function importChapter(
  user: SessionUser,
  seriesId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  mockCurrentUser(user);
  return importRoute(
    new NextRequest(`${ORIGIN}/api/series/${seriesId}/chapters/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext({ id: seriesId }),
  );
}

async function fetchJob(user: SessionUser, jobId: string): Promise<JobView> {
  mockCurrentUser(user);
  const response = await getJobRoute(
    new NextRequest(`${ORIGIN}/api/jobs/${jobId}`),
    routeContext({ id: jobId }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as JobView;
}

async function fetchChapters(user: SessionUser, seriesId: string): Promise<ChapterListResponse> {
  mockCurrentUser(user);
  const response = await getChaptersRoute(
    new NextRequest(`${ORIGIN}/api/series/${seriesId}/chapters`),
    routeContext({ id: seriesId }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as ChapterListResponse;
}

/* -------------------------------------------------------------------------- */
/* Test                                                                       */
/* -------------------------------------------------------------------------- */

describe("content pipeline: upload -> import -> job -> chapter -> reader", () => {
  it("carries a manual upload end to end through every route seam", async () => {
    const userA = await createTestUser({ displayName: "Creator" });
    const userB = await createTestUser({ displayName: "Member" });

    // ---- fixtures: a series and a 3-page zip out of natural order ---------
    const series = await createSeries(userA, {
      title: "Pipeline Test Series",
      originalTitle: null,
      synopsis: null,
      mediaType: "MANGA",
      visibility: "SHARED",
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
    const seriesId = series.id;

    const RED = { r: 255, g: 0, b: 0 };
    const GREEN = { r: 0, g: 255, b: 0 };
    const BLUE = { r: 0, g: 0, b: 255 };
    // Distinct real dimensions per page, so width/height in the response can
    // only have come from sharp reading the *right* file for each slot.
    const page1 = await makePng(10, 6, RED); // page-1.png  -> reading order 1
    const page2 = await makePng(12, 7, GREEN); // page-2.png  -> reading order 2
    const page10 = await makePng(14, 8, BLUE); // page-10.png -> reading order 3

    const zip = buildZip([
      { name: "page-10.png", data: page10 },
      { name: "page-2.png", data: page2 },
      { name: "page-1.png", data: page1 },
    ]);

    /* ---- Step 1: real chunked upload, then the import route -------------- */
    const uploadId = await uploadWholeFile(userA, "chapter.zip", zip, "application/zip");

    const importResponse = await importChapter(userA, seriesId, {
      kind: "archive",
      uploadIds: [uploadId],
      title: "Chapter 1",
      number: 1,
    });
    expect(importResponse.status).toBe(202);
    const { jobId } = (await importResponse.json()) as EnqueuedJobResponse;

    /* ---- Step 2: drain the runner, check the job ------------------------- */
    await processJobsUntilIdle({ timeoutMs: 30_000 });

    const job = await fetchJob(userA, jobId);
    expect(job.status).toBe("SUCCEEDED");
    const jobResult = job.result as { chapterId: string; pageCount: number };
    expect(jobResult.chapterId).toBeTruthy();
    expect(jobResult.pageCount).toBe(3);

    // The upload's scratch directory is consumed once the chapter exists.
    expect(existsSync(path.join(dataRoot, "tmp", "uploads", uploadId))).toBe(false);

    /* ---- Step 3: chapter list + detail, natural page order on disk ------- */
    const chaptersAfterImport = await fetchChapters(userA, seriesId);
    expect(chaptersAfterImport.chapters).toHaveLength(1);
    const chapterListItem = chaptersAfterImport.chapters[0]!;
    expect(chapterListItem.id).toBe(jobResult.chapterId);
    expect(chapterListItem.origin).toBe("MANUAL");
    expect(chapterListItem.status).toBe("COMPLETED");
    expect(chapterListItem.pageCount).toBe(3);
    expect(chapterListItem.read).toBe(false);
    expect(chaptersAfterImport.readableCount).toBe(1);

    const chapterId = chapterListItem.id;

    mockCurrentUser(userA);
    const detailResponse = await getChapterRoute(
      new NextRequest(`${ORIGIN}/api/chapters/${chapterId}`),
      routeContext({ id: chapterId }),
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as ChapterDetail;
    expect(detail.pages).toHaveLength(3);
    const [p1, p2, p3] = detail.pages;
    expect(p1 && p2 && p3).toBeTruthy();
    expect([p1!.index, p2!.index, p3!.index]).toEqual([1, 2, 3]);
    expect(p1!.url).toBe(`/api/pages/${p1!.id}/image`);
    expect(p2!.url).toBe(`/api/pages/${p2!.id}/image`);
    expect(p3!.url).toBe(`/api/pages/${p3!.id}/image`);
    // Widths/heights come from sharp reading the stored file for each slot.
    expect([p1!.width, p1!.height]).toEqual([10, 6]);
    expect([p2!.width, p2!.height]).toEqual([12, 7]);
    expect([p3!.width, p3!.height]).toEqual([14, 8]);

    // Files on disk: natural order (page-1, page-2, page-10) becomes 001/002/003,
    // and each is byte-identical to its source image (a straight move, not a
    // re-encode).
    const chapterRow = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } });
    const dir = chapterDir(seriesId, chapterRow.slug);
    expect(readFileSync(path.join(dir, "001.png"))).toEqual(page1);
    expect(readFileSync(path.join(dir, "002.png"))).toEqual(page2);
    expect(readFileSync(path.join(dir, "003.png"))).toEqual(page10);

    /* ---- Step 4: page image route: caching, ETag, visibility ------------- */
    mockCurrentUser(userA);
    const imageResponse = await getPageImageRoute(
      new NextRequest(`${ORIGIN}/api/pages/${p1!.id}/image`),
      routeContext({ id: p1!.id }),
    );
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("cache-control")).toContain("immutable");
    const etag = imageResponse.headers.get("etag");
    expect(etag).toBeTruthy();

    mockCurrentUser(userA);
    const notModifiedResponse = await getPageImageRoute(
      new NextRequest(`${ORIGIN}/api/pages/${p1!.id}/image`, {
        headers: { "if-none-match": etag as string },
      }),
      routeContext({ id: p1!.id }),
    );
    expect(notModifiedResponse.status).toBe(304);

    // User B does not track the series, but it is SHARED, so a plain member
    // can view its pages.
    mockCurrentUser(userB);
    const memberResponse = await getPageImageRoute(
      new NextRequest(`${ORIGIN}/api/pages/${p1!.id}/image`),
      routeContext({ id: p1!.id }),
    );
    expect(memberResponse.status).toBe(200);

    await prisma.series.update({ where: { id: seriesId }, data: { visibility: "PRIVATE" } });
    mockCurrentUser(userB);
    const privateResponse = await getPageImageRoute(
      new NextRequest(`${ORIGIN}/api/pages/${p1!.id}/image`),
      routeContext({ id: p1!.id }),
    );
    expect(privateResponse.status).toBe(404);
    await prisma.series.update({ where: { id: seriesId }, data: { visibility: "SHARED" } });

    /* ---- Step 5: reading position marks the chapter read ------------------ */
    mockCurrentUser(userA);
    const positionResponse = await putPositionRoute(
      new NextRequest(`${ORIGIN}/api/series/${seriesId}/position`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chapterId, pageIndex: 2 }),
      }),
      routeContext({ id: seriesId }),
    );
    expect(positionResponse.status).toBe(200);
    const position = (await positionResponse.json()) as ReadingPositionView;
    expect(position.chapterId).toBe(chapterId);
    expect(position.pageIndex).toBe(2);

    const chaptersAfterPosition = await fetchChapters(userA, seriesId);
    expect(chaptersAfterPosition.chapters[0]!.read).toBe(true);

    const libraryEntry = await prisma.libraryEntry.findUniqueOrThrow({
      where: { userId_seriesId: { userId: userA.id, seriesId } },
    });
    expect(libraryEntry.currentChapter).toBe(1);
    expect(libraryEntry.status).toBe("READING");

    mockCurrentUser(userA);
    const unreadResponse = await putChapterReadRoute(
      new NextRequest(`${ORIGIN}/api/chapters/${chapterId}/read`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ read: false }),
      }),
      routeContext({ id: chapterId }),
    );
    expect(unreadResponse.status).toBe(200);
    const unreadBody = (await unreadResponse.json()) as ChapterListItem;
    expect(unreadBody.read).toBe(false);

    const chaptersAfterUnread = await fetchChapters(userA, seriesId);
    expect(chaptersAfterUnread.chapters[0]!.read).toBe(false);

    /* ---- Step 6: re-import the same zip, then delete ---------------------- */
    const uploadId2 = await uploadWholeFile(userA, "chapter-again.zip", zip, "application/zip");
    const importResponse2 = await importChapter(userA, seriesId, {
      kind: "archive",
      uploadIds: [uploadId2],
      title: "Chapter 1 (again)",
      number: 1,
    });
    expect(importResponse2.status).toBe(202);
    const { jobId: jobId2 } = (await importResponse2.json()) as EnqueuedJobResponse;

    await processJobsUntilIdle({ timeoutMs: 30_000 });
    const job2 = await fetchJob(userA, jobId2);
    expect(job2.status).toBe("SUCCEEDED");
    const jobResult2 = job2.result as { chapterId: string; pageCount: number };
    expect(jobResult2.pageCount).toBe(3);
    // Manual slugs are timestamped + randomised, so a second import of the
    // same bytes gets its own chapter rather than colliding.
    expect(jobResult2.chapterId).not.toBe(chapterId);
    const chapterRow2 = await prisma.chapter.findUniqueOrThrow({
      where: { id: jobResult2.chapterId },
    });
    expect(chapterRow2.slug).not.toBe(chapterRow.slug);

    const seriesBeforeDelete = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } });
    expect(seriesBeforeDelete.chapterCount).toBe(2);

    mockCurrentUser(userA);
    const deleteResponse = await deleteChapterRoute(
      new NextRequest(`${ORIGIN}/api/chapters/${chapterId}`, { method: "DELETE" }),
      routeContext({ id: chapterId }),
    );
    expect(deleteResponse.status).toBe(204);
    expect(existsSync(dir)).toBe(false);

    const seriesAfterDelete = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } });
    expect(seriesAfterDelete.chapterCount).toBe(1);

    // User B (a member, not the creator or an admin) may not delete.
    mockCurrentUser(userB);
    const deleteAsMemberResponse = await deleteChapterRoute(
      new NextRequest(`${ORIGIN}/api/chapters/${jobResult2.chapterId}`, { method: "DELETE" }),
      routeContext({ id: jobResult2.chapterId }),
    );
    expect(deleteAsMemberResponse.status).toBe(403);

    const seriesAfterForbiddenDelete = await prisma.series.findUniqueOrThrow({
      where: { id: seriesId },
    });
    expect(seriesAfterForbiddenDelete.chapterCount).toBe(1);
  });
});
