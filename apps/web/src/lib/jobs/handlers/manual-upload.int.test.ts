/**
 * Manual chapter import end to end: the import route enqueues the job, and the
 * MANUAL_UPLOAD handler turns a zip (or a list of images) into files on disk
 * plus one `createLocalChapter` call.
 *
 * `@/lib/content/chapters` is mocked: the content-core owner implements
 * `createLocalChapter`, and this file is about the runner and the handler, not
 * about Chapter/Page rows. Drop the mock once that module is real.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../../test/factories";
import { buildZip, TINY_PNG } from "../../../../test/zip-fixture";
import { POST as importRoute } from "@/app/api/series/[id]/chapters/import/route";
import { POST as optimizeRoute } from "@/app/api/series/[id]/optimize/route";
import type { SessionUser } from "@/lib/auth/types";
import type { CreateLocalChapterInput } from "@/lib/content/chapters";
import type { EnqueuedJobResponse } from "@/lib/contracts/content";
import { resetEnvCache } from "@/lib/env";
import { chapterDir } from "@/lib/content/store";
import { processJobsUntilIdle, stopJobRunner } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { createUploadSession, completeUpload, writeChunk } from "@/lib/uploads/sessions";
// Registers the MANUAL_UPLOAD handler as a side effect.
import "@/lib/jobs/handlers/manual-upload";

const { createLocalChapterMock } = vi.hoisted(() => ({ createLocalChapterMock: vi.fn() }));

vi.mock("@/lib/content/chapters", () => ({ createLocalChapter: createLocalChapterMock }));

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

let dataRoot: string;

beforeAll(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-manual-"));
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
  createLocalChapterMock.mockReset();
  createLocalChapterMock.mockImplementation(async (input: CreateLocalChapterInput) => ({
    chapterId: "00000000-0000-4000-8000-000000000001",
    pageCount: input.pages.length,
    bytes: input.pages.reduce((sum, page) => sum + (page.bytes ?? 0), 0),
  }));
});

async function seedSeries(user: SessionUser): Promise<string> {
  const title = `Manual ${Math.random().toString(36).slice(2, 8)}`;
  const series = await prisma.series.create({
    data: { title, sortTitle: title.toLowerCase(), createdById: user.id },
  });
  return series.id;
}

/** Push `data` through the real session API as a single-chunk upload. */
async function uploadFile(user: SessionUser, filename: string, data: Buffer): Promise<string> {
  const session = await createUploadSession(user.id, { filename, size: data.length });
  await writeChunk(user.id, session.id, 0, new Uint8Array(data));
  await completeUpload(user.id, session.id);
  return session.id;
}

function threePageZip(): Buffer {
  return buildZip([
    { name: "10.png", data: TINY_PNG },
    { name: "2.png", data: TINY_PNG },
    { name: "1.png", data: TINY_PNG },
    { name: "__MACOSX/._1.png", data: Buffer.from("junk") },
    { name: "ComicInfo.xml", data: Buffer.from("<xml/>") },
  ]);
}

async function callImport(
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

describe("POST /api/series/:id/chapters/import", () => {
  it("enqueues MANUAL_UPLOAD with the config the handler expects", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const uploadId = await uploadFile(user, "chapter.cbz", threePageZip());

    const response = await callImport(user, seriesId, {
      kind: "archive",
      uploadIds: [uploadId],
      title: "Chapter 1",
      number: 1,
      volume: "1",
    });

    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as EnqueuedJobResponse;
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.kind).toBe("MANUAL_UPLOAD");
    expect(job.seriesId).toBe(seriesId);
    expect(job.requestedById).toBe(user.id);
    expect(job.configJson).toEqual({
      seriesId,
      uploadIds: [uploadId],
      kind: "archive",
      title: "Chapter 1",
      number: 1,
      volume: "1",
    });
  });

  it("enqueues PDF_IMPORT with the render settings", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const uploadId = await uploadFile(user, "book.pdf", Buffer.from("%PDF-1.4"));

    const response = await callImport(user, seriesId, {
      kind: "pdf",
      uploadIds: [uploadId],
      title: "Volume 1",
      pdf: { scale: 2, maxWidth: 2000 },
    });

    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as EnqueuedJobResponse;
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.kind).toBe("PDF_IMPORT");
    expect(job.configJson).toMatchObject({ uploadId, scale: 2, maxWidth: 2000 });
    expect((job.configJson as { uploadPath?: string }).uploadPath).toContain(uploadId);
  });

  it("defaults the PDF render settings when the client omits them", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const uploadId = await uploadFile(user, "book.pdf", Buffer.from("%PDF-1.4"));

    const response = await callImport(user, seriesId, {
      kind: "pdf",
      uploadIds: [uploadId],
      title: "Volume 1",
    });

    const { jobId } = (await response.json()) as EnqueuedJobResponse;
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.configJson).toMatchObject({ scale: 1.5, maxWidth: 1600 });
  });

  it("rejects an upload that was never completed", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const session = await createUploadSession(user.id, { filename: "x.cbz", size: 10 });

    const response = await callImport(user, seriesId, {
      kind: "archive",
      uploadIds: [session.id],
      title: "Chapter 1",
    });

    expect(response.status).toBe(409);
    expect(await prisma.job.count()).toBe(0);
  });

  it("rejects an upload owned by someone else", async () => {
    const owner = await createTestUser();
    const thief = await createTestUser();
    const seriesId = await seedSeries(thief);
    const uploadId = await uploadFile(owner, "chapter.cbz", threePageZip());

    const response = await callImport(thief, seriesId, {
      kind: "archive",
      uploadIds: [uploadId],
      title: "Chapter 1",
    });

    expect(response.status).toBe(404);
  });

  it("refuses a member who does not own the series", async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const seriesId = await seedSeries(owner);
    const uploadId = await uploadFile(member, "chapter.cbz", threePageZip());

    const response = await callImport(member, seriesId, {
      kind: "archive",
      uploadIds: [uploadId],
      title: "Chapter 1",
    });

    expect(response.status).toBe(403);
  });

  it("refuses more than one upload for an archive import", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const a = await uploadFile(user, "a.cbz", threePageZip());
    const b = await uploadFile(user, "b.cbz", threePageZip());

    const response = await callImport(user, seriesId, {
      kind: "archive",
      uploadIds: [a, b],
      title: "Chapter 1",
    });

    expect(response.status).toBe(400);
  });
});

describe("MANUAL_UPLOAD handler", () => {
  it("extracts a zip, names pages in reading order and registers the chapter", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const uploadId = await uploadFile(user, "chapter.cbz", threePageZip());
    const response = await callImport(user, seriesId, {
      kind: "archive",
      uploadIds: [uploadId],
      title: "Chapter 1",
      number: 1,
    });
    const { jobId } = (await response.json()) as EnqueuedJobResponse;

    await processJobsUntilIdle({ timeoutMs: 30_000 });

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("SUCCEEDED");
    expect(job.resultJson).toMatchObject({ pageCount: 3 });

    expect(createLocalChapterMock).toHaveBeenCalledTimes(1);
    const input = createLocalChapterMock.mock.calls[0]?.[0] as CreateLocalChapterInput;
    expect(input.seriesId).toBe(seriesId);
    expect(input.origin).toBe("MANUAL");
    expect(input.title).toBe("Chapter 1");
    expect(input.number).toBe(1);
    expect(input.slug).toMatch(/^manual-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(input.pages.map((page) => page.index)).toEqual([1, 2, 3]);

    // Natural order (1, 2, 10) becomes 001, 002, 003 on disk.
    const dir = chapterDir(seriesId, input.slug);
    expect(readdirSync(dir).sort()).toEqual(["001.png", "002.png", "003.png"]);
    expect(input.pages.every((page) => existsSync(page.path))).toBe(true);
    expect(input.pages.every((page) => (page.bytes ?? 0) === TINY_PNG.length)).toBe(true);

    // The consumed upload is gone, and so is the job's scratch directory.
    expect(existsSync(path.join(dataRoot, "tmp", "uploads", uploadId))).toBe(false);
    expect(existsSync(path.join(dataRoot, "tmp", "jobs", jobId))).toBe(false);
  });

  it("keeps the client's order for an images import", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const second = await uploadFile(user, "zzz.png", TINY_PNG);
    const first = await uploadFile(user, "aaa.png", TINY_PNG);

    const response = await callImport(user, seriesId, {
      kind: "images",
      uploadIds: [second, first],
      title: "Chapter 2",
    });
    expect(response.status).toBe(202);
    await processJobsUntilIdle({ timeoutMs: 30_000 });

    const input = createLocalChapterMock.mock.calls[0]?.[0] as CreateLocalChapterInput;
    const dir = chapterDir(seriesId, input.slug);
    expect(readdirSync(dir).sort()).toEqual(["001.png", "002.png"]);
    expect(input.pages).toHaveLength(2);
  });

  it("fails with NO_IMAGES when the archive holds none", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const uploadId = await uploadFile(
      user,
      "empty.cbz",
      buildZip([{ name: "readme.txt", data: Buffer.from("nothing here") }]),
    );
    const response = await callImport(user, seriesId, {
      kind: "archive",
      uploadIds: [uploadId],
      title: "Chapter 1",
    });
    const { jobId } = (await response.json()) as EnqueuedJobResponse;

    await processJobsUntilIdle({ timeoutMs: 30_000 });

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("NO_IMAGES");
    expect(createLocalChapterMock).not.toHaveBeenCalled();
    // The upload survives a failure so the user can retry without re-uploading.
    expect(existsSync(path.join(dataRoot, "tmp", "uploads", uploadId))).toBe(true);
  });

  it("fails with INVALID_ARCHIVE on a corrupt zip", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const uploadId = await uploadFile(user, "broken.cbz", Buffer.from("not a zip at all"));
    const response = await callImport(user, seriesId, {
      kind: "archive",
      uploadIds: [uploadId],
      title: "Chapter 1",
    });
    const { jobId } = (await response.json()) as EnqueuedJobResponse;

    await processJobsUntilIdle({ timeoutMs: 30_000 });

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("INVALID_ARCHIVE");
  });

  it("fails with UPLOAD_MISSING when the upload disappeared before the job ran", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const uploadId = await uploadFile(user, "chapter.cbz", threePageZip());
    const response = await callImport(user, seriesId, {
      kind: "archive",
      uploadIds: [uploadId],
      title: "Chapter 1",
    });
    const { jobId } = (await response.json()) as EnqueuedJobResponse;
    rmSync(path.join(dataRoot, "tmp", "uploads", uploadId), { recursive: true, force: true });

    await processJobsUntilIdle({ timeoutMs: 30_000 });

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("UPLOAD_MISSING");
    // Not retried: the uploads a retry would need are exactly what is gone.
    expect(job.attempt).toBe(1);
  });
});

describe("POST /api/series/:id/optimize", () => {
  it("enqueues OPTIMIZE with the requester's own optimizer preferences", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { optimizerFormat: "WEBP", optimizerQuality: 62 },
    });
    const seriesId = await seedSeries(user);

    mockCurrentUser(user);
    const response = await optimizeRoute(
      new NextRequest(`${ORIGIN}/api/series/${seriesId}/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      routeContext({ id: seriesId }),
    );

    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as EnqueuedJobResponse;
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.kind).toBe("OPTIMIZE");
    expect(job.configJson).toEqual({ seriesId, format: "WEBP", quality: 62 });
  });

  it("refuses a user who cannot edit the series", async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const seriesId = await seedSeries(owner);

    mockCurrentUser(member);
    const response = await optimizeRoute(
      new NextRequest(`${ORIGIN}/api/series/${seriesId}/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      routeContext({ id: seriesId }),
    );

    expect(response.status).toBe(403);
  });
});
