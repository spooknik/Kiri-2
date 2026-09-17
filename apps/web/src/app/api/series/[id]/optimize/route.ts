/**
 * POST /api/series/:id/optimize — re-encode a series' images.
 *
 * Format and quality are the requester's profile settings, read from their
 * User row rather than accepted from the request: the optimiser rewrites page
 * files in place, so the knobs belong to a person, not to a form post.
 * 202 with the job id; poll /api/jobs/:id.
 */
import { z } from "zod";
import { jsonResponse, notFound, withAuth } from "@/lib/api";
import { assertCanEditSeries } from "@/lib/authz";
import { optimizeSeriesSchema, type EnqueuedJobResponse } from "@/lib/contracts";
import { enqueueJob } from "@/lib/jobs/queue";
import { triggerJobProcessing } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const POST = withAuth(
  { params: paramsSchema, body: optimizeSeriesSchema },
  async ({ user, params, body }) => {
    const series = await prisma.series.findUnique({
      where: { id: params.id },
      select: { id: true, visibility: true, isAdult: true, createdById: true },
    });
    if (!series) throw notFound("Series");
    assertCanEditSeries(user, series);

    const prefs = await prisma.user.findUnique({
      where: { id: user.id },
      select: { optimizerFormat: true, optimizerQuality: true },
    });
    if (!prefs) throw notFound("User");

    const job = await enqueueJob({
      kind: "OPTIMIZE",
      seriesId: series.id,
      requestedById: user.id,
      config: {
        seriesId: series.id,
        ...(body.chapterIds ? { chapterIds: body.chapterIds } : {}),
        format: prefs.optimizerFormat,
        quality: prefs.optimizerQuality,
      },
    });

    triggerJobProcessing();
    return jsonResponse({ jobId: job.id } satisfies EnqueuedJobResponse, { status: 202 });
  },
);
