/**
 * Integration test for the OPTIMIZE handler: real embedded Postgres, real
 * DATA_ROOT temp dir, real images run through the real optimizeChapter.
 * Exercises the COMPLETED-only filter, the optional chapterIds allow-list,
 * per-chapter progress, and result aggregation.
 */
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestUser, resetDatabase } from "../../../../test/factories";
import type { JobProgress } from "@/lib/contracts/content";
import { resetEnvCache } from "@/lib/env";
import type { JobContext } from "@/lib/jobs/types";
import { prisma } from "@/lib/prisma";
import { toSortTitle } from "@/lib/text";
import { handleOptimize } from "./optimize";

const DATA_ROOT = path.resolve(process.cwd(), "data", `test-optimize-handler-${process.pid}`);

beforeAll(() => {
  process.env.DATA_ROOT = DATA_ROOT;
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await rm(DATA_ROOT, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

async function writeNoisePng(filePath: string, size = 40): Promise<void> {
  const channels = 3;
  const raw = Buffer.alloc(size * size * channels);
  for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(Math.random() * 256);
  await sharp(raw, { raw: { width: size, height: size, channels } })
    .png()
    .toFile(filePath);
}

async function seedChapter(
  seriesId: string,
  slug: string,
  status: "COMPLETED" | "PENDING",
  sortIndex: number,
  pageCount: number,
): Promise<string> {
  const chapter = await prisma.chapter.create({
    data: { seriesId, slug, title: slug, status, origin: "MANUAL", sortIndex, pageCount },
    select: { id: true },
  });
  const dir = path.join(DATA_ROOT, "library", seriesId, slug);
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= pageCount; i += 1) {
    const file = `${String(i).padStart(3, "0")}.png`;
    await writeNoisePng(path.join(dir, file));
    const bytes = (await stat(path.join(dir, file))).size;
    await prisma.page.create({ data: { chapterId: chapter.id, index: i, file, bytes } });
  }
  return chapter.id;
}

function fakeCtx(config: Record<string, unknown>): { ctx: JobContext; progress: JobProgress[] } {
  const progress: JobProgress[] = [];
  const ctx: JobContext = {
    job: {
      id: "job-1",
      kind: "OPTIMIZE",
      seriesId: null,
      sourceId: null,
      pluginId: null,
      requestedById: null,
      attempt: 0,
      config,
    },
    signal: new AbortController().signal,
    log: () => {},
    progress: async (update) => {
      progress.push(update);
    },
    heartbeat: async () => {},
    tmpDir: DATA_ROOT,
  };
  return { ctx, progress };
}

async function seedSeries(): Promise<string> {
  const user = await createTestUser();
  const series = await prisma.series.create({
    data: { title: "Test Series", sortTitle: toSortTitle("Test Series"), createdById: user.id },
    select: { id: true },
  });
  return series.id;
}

describe("handleOptimize", () => {
  it("optimizes every COMPLETED chapter of the series, in sortIndex order, and aggregates results", async () => {
    const seriesId = await seedSeries();
    const chapter1 = await seedChapter(seriesId, "ch-1", "COMPLETED", 0, 2);
    const chapter2 = await seedChapter(seriesId, "ch-2", "COMPLETED", 1, 1);
    await seedChapter(seriesId, "ch-3-pending", "PENDING", 2, 1);

    const { ctx, progress } = fakeCtx({ seriesId, format: "WEBP", quality: 80 });
    const result = await handleOptimize(ctx);

    expect(result.chaptersProcessed).toBe(2);
    expect(result.pagesConverted).toBe(3);
    expect(result.bytesAfter).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(result.chapters.map((c) => c.chapterId)).toEqual([chapter1, chapter2]);

    expect(progress).toEqual([
      { phase: "optimize", current: 1, total: 2, chapterSlug: "ch-1" },
      { phase: "optimize", current: 2, total: 2, chapterSlug: "ch-2" },
    ]);

    // Pending chapter's page was never touched.
    const pendingPages = await prisma.page.findMany({
      where: { chapter: { seriesId, slug: "ch-3-pending" } },
    });
    expect(pendingPages[0]?.file).toBe("001.png");
  });

  it("restricts to the given chapterIds, still filtered to COMPLETED", async () => {
    const seriesId = await seedSeries();
    const chapter1 = await seedChapter(seriesId, "ch-1", "COMPLETED", 0, 1);
    await seedChapter(seriesId, "ch-2", "COMPLETED", 1, 1);
    const pendingId = await seedChapter(seriesId, "ch-3-pending", "PENDING", 2, 1);

    const { ctx, progress } = fakeCtx({
      seriesId,
      format: "WEBP",
      quality: 80,
      chapterIds: [chapter1, pendingId],
    });
    const result = await handleOptimize(ctx);

    expect(result.chaptersProcessed).toBe(1);
    expect(result.chapters.map((c) => c.chapterId)).toEqual([chapter1]);
    expect(progress).toEqual([{ phase: "optimize", current: 1, total: 1, chapterSlug: "ch-1" }]);
  });

  it("rejects an invalid config", async () => {
    const { ctx } = fakeCtx({ seriesId: "not-a-uuid", format: "WEBP", quality: 80 });
    await expect(handleOptimize(ctx)).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});
