/**
 * OPTIMIZE job handler.
 * Config: `{ seriesId, chapterIds?: string[], format: "WEBP", quality: number }`.
 *
 * Runs every COMPLETED chapter of the series — or just `chapterIds` when
 * given, still filtered to COMPLETED — through `optimizeChapter` one at a
 * time (never in parallel: sequential keeps memory bounded for large chapters
 * and makes progress reporting straightforward) and aggregates the result.
 */
import { z } from "zod";
import { JobFailure, registerJobHandler, type JobContext } from "@/lib/jobs/types";
import { OPTIMIZER_FORMATS, optimizeChapter } from "@/lib/media/optimizer";
import { prisma } from "@/lib/prisma";

const configSchema = z.object({
  seriesId: z.uuid(),
  chapterIds: z.array(z.uuid()).max(500).optional(),
  format: z.enum(OPTIMIZER_FORMATS),
  quality: z.number().int().min(1).max(100),
});

export interface OptimizeChapterOutcome {
  chapterId: string;
  slug: string;
  pagesConverted: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface OptimizeResult {
  chaptersProcessed: number;
  pagesConverted: number;
  bytesBefore: number;
  bytesAfter: number;
  chapters: OptimizeChapterOutcome[];
}

export async function handleOptimize(ctx: JobContext): Promise<OptimizeResult> {
  const parsed = configSchema.safeParse(ctx.job.config);
  if (!parsed.success) {
    throw new JobFailure("INVALID_CONFIG", `Invalid OPTIMIZE config: ${parsed.error.message}`);
  }
  const config = parsed.data;

  const chapters = await prisma.chapter.findMany({
    where:
      config.chapterIds && config.chapterIds.length > 0
        ? { id: { in: config.chapterIds }, seriesId: config.seriesId, status: "COMPLETED" }
        : { seriesId: config.seriesId, status: "COMPLETED" },
    orderBy: { sortIndex: "asc" },
    select: { id: true, slug: true },
  });

  ctx.log(`Optimizing ${chapters.length} chapter(s) to ${config.format} q${config.quality}`);

  const outcomes: OptimizeChapterOutcome[] = [];
  let pagesConverted = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (let i = 0; i < chapters.length; i += 1) {
    if (ctx.signal.aborted) {
      throw new JobFailure("CANCELLED", "Optimize job was cancelled", { retryable: false });
    }
    const chapter = chapters[i];
    if (!chapter) continue;

    const result = await optimizeChapter({
      chapterId: chapter.id,
      format: config.format,
      quality: config.quality,
      signal: ctx.signal,
    });

    pagesConverted += result.pagesConverted;
    bytesBefore += result.bytesBefore;
    bytesAfter += result.bytesAfter;
    outcomes.push({ chapterId: chapter.id, slug: chapter.slug, ...result });

    await ctx.progress({
      phase: "optimize",
      current: i + 1,
      total: chapters.length,
      chapterSlug: chapter.slug,
    });
  }

  return {
    chaptersProcessed: chapters.length,
    pagesConverted,
    bytesBefore,
    bytesAfter,
    chapters: outcomes,
  };
}

registerJobHandler("OPTIMIZE", handleOptimize);
