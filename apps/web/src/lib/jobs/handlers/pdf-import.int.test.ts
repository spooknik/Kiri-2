/**
 * Integration test for the PDF_IMPORT handler: real embedded Postgres, real
 * DATA_ROOT temp dir, real PDF rendering against the tiny fixture PDF.
 *
 * `createLocalChapter` (src/lib/content/chapters.ts) is still a throwing stub
 * owned by the content-core agent at the time this was written, so it is
 * mocked here — everything up to and including the call into it (upload
 * resolution, the pre-render duplicate check, rendering, moving pages into
 * `library/<seriesId>/<slug>`, and post-import cleanup) is exercised for
 * real.
 */
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser, resetDatabase } from "../../../../test/factories";
import type { JobProgress } from "@/lib/contracts/content";
import { resetEnvCache } from "@/lib/env";
import type { JobContext } from "@/lib/jobs/types";
import { chapterSlugForSha, sha256File } from "@/lib/media/pdf";
import { prisma } from "@/lib/prisma";
import { toSortTitle } from "@/lib/text";

vi.mock("@/lib/content/chapters", () => ({
  createLocalChapter: vi.fn(),
}));

import { createLocalChapter } from "@/lib/content/chapters";
import { handlePdfImport } from "./pdf-import";

const FIXTURE = path.resolve(__dirname, "../../../../test/fixtures/tiny-2page.pdf");
const DATA_ROOT = path.resolve(process.cwd(), "data", `test-pdf-import-${process.pid}`);

beforeAll(() => {
  process.env.DATA_ROOT = DATA_ROOT;
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(createLocalChapter).mockReset();
});

afterAll(async () => {
  await rm(DATA_ROOT, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

async function seedSeries(): Promise<string> {
  const user = await createTestUser();
  const series = await prisma.series.create({
    data: { title: "Test Series", sortTitle: toSortTitle("Test Series"), createdById: user.id },
    select: { id: true },
  });
  return series.id;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function fakeCtx(
  config: Record<string, unknown>,
  tmpDir: string,
): { ctx: JobContext; progress: JobProgress[]; logs: string[] } {
  const logs: string[] = [];
  const progress: JobProgress[] = [];
  const ctx: JobContext = {
    job: {
      id: "job-1",
      kind: "PDF_IMPORT",
      seriesId: null,
      sourceId: null,
      pluginId: null,
      requestedById: null,
      attempt: 0,
      config,
    },
    signal: new AbortController().signal,
    log: (line) => {
      logs.push(line);
    },
    progress: async (update) => {
      progress.push(update);
    },
    heartbeat: async () => {},
    tmpDir,
  };
  return { ctx, progress, logs };
}

describe("handlePdfImport", () => {
  it("resolves the upload via the documented uploadId fallback path, renders, imports, and cleans up", async () => {
    const seriesId = await seedSeries();
    const uploadId = "11111111-1111-4111-8111-111111111111";
    const uploadDir = path.join(DATA_ROOT, "tmp", "uploads", uploadId);
    await mkdir(uploadDir, { recursive: true });
    await copyFile(FIXTURE, path.join(uploadDir, "file"));

    const tmp = await tempDir("kiri-pdf-import-tmp-");
    const { ctx, progress } = fakeCtx(
      { seriesId, uploadId, title: "Chapter 1", number: 1, volume: null },
      tmp,
    );

    vi.mocked(createLocalChapter).mockResolvedValue({
      chapterId: "chapter-1",
      pageCount: 2,
      bytes: 100,
    });

    const expectedSha = await sha256File(FIXTURE);
    const expectedSlug = chapterSlugForSha(expectedSha);

    const result = await handlePdfImport(ctx);

    expect(result).toEqual({ chapterId: "chapter-1", pageCount: 2, slug: expectedSlug });
    expect(progress[0]).toMatchObject({ phase: "render", current: 1, total: 2 });
    expect(progress[1]).toMatchObject({ phase: "render", current: 2, total: 2 });

    expect(createLocalChapter).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createLocalChapter).mock.calls[0]?.[0];
    expect(call?.seriesId).toBe(seriesId);
    expect(call?.slug).toBe(expectedSlug);
    expect(call?.origin).toBe("PDF");
    expect(call?.title).toBe("Chapter 1");
    expect(call?.number).toBe(1);
    expect(call?.volume).toBeNull();
    expect(call?.pages).toHaveLength(2);

    const libraryDir = path.join(DATA_ROOT, "library", seriesId, expectedSlug);
    for (const page of call?.pages ?? []) {
      expect(page.path.startsWith(libraryDir)).toBe(true);
      await expect(stat(page.path)).resolves.toBeDefined();
    }

    // Upload dir removed after a successful import.
    await expect(stat(uploadDir)).rejects.toThrow();
  });

  it("rejects a duplicate PDF before rendering", async () => {
    const seriesId = await seedSeries();
    const expectedSha = await sha256File(FIXTURE);
    const slug = chapterSlugForSha(expectedSha);
    await prisma.chapter.create({
      data: { seriesId, slug, title: "Existing", status: "COMPLETED", origin: "PDF", sortIndex: 0 },
    });

    const uploadId = "22222222-2222-4222-8222-222222222222";
    const uploadPath = path.join(DATA_ROOT, "tmp", "explicit-upload", "renamed.pdf");
    await mkdir(path.dirname(uploadPath), { recursive: true });
    await copyFile(FIXTURE, uploadPath);

    const tmp = await tempDir("kiri-pdf-import-dup-");
    const { ctx } = fakeCtx(
      { seriesId, uploadId, uploadPath, title: "Chapter 1", number: null, volume: null },
      tmp,
    );

    await expect(handlePdfImport(ctx)).rejects.toMatchObject({ code: "DUPLICATE_PDF" });
    expect(createLocalChapter).not.toHaveBeenCalled();
    expect(await readdir(tmp)).toEqual([]); // never rendered
  });

  it("honors an explicit uploadPath in config and cleans up its directory", async () => {
    const seriesId = await seedSeries();
    const uploadId = "33333333-3333-4333-8333-333333333333";
    const customDir = await tempDir("kiri-pdf-import-custom-upload-");
    const uploadPath = path.join(customDir, "file");
    await copyFile(FIXTURE, uploadPath);

    const tmp = await tempDir("kiri-pdf-import-tmp2-");
    const { ctx } = fakeCtx(
      { seriesId, uploadId, uploadPath, title: "Chapter 2", number: null, volume: "Vol 1" },
      tmp,
    );
    vi.mocked(createLocalChapter).mockResolvedValue({
      chapterId: "chapter-2",
      pageCount: 2,
      bytes: 50,
    });

    await handlePdfImport(ctx);

    await expect(stat(customDir)).rejects.toThrow();
  });

  it("rejects an invalid config", async () => {
    const { ctx } = fakeCtx({ seriesId: "not-a-uuid" }, await tempDir("kiri-pdf-import-badcfg-"));
    await expect(handlePdfImport(ctx)).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("throws INVALID_PDF when the upload file is missing", async () => {
    const seriesId = await seedSeries();
    const uploadId = "44444444-4444-4444-8444-444444444444";
    const { ctx } = fakeCtx(
      { seriesId, uploadId, title: "X", number: null, volume: null },
      await tempDir("kiri-pdf-import-missing-"),
    );
    await expect(handlePdfImport(ctx)).rejects.toMatchObject({ code: "INVALID_PDF" });
  });
});
