/**
 * POST /api/series/:id/chapters/import — turn finished uploads into a chapter.
 *
 * Validation happens here, work happens in a job: the uploads are checked for
 * existence, completeness and ownership before anything is enqueued, so the
 * user sees a 4xx immediately rather than a job that fails a second later.
 * The response is 202 with the job id; poll /api/jobs/:id for progress.
 */
import { z } from "zod";
import { badRequest, jsonResponse, notFound, withAuth } from "@/lib/api";
import { assertCanEditSeries } from "@/lib/authz";
import { importChapterSchema, type EnqueuedJobResponse } from "@/lib/contracts";
import { enqueueJob } from "@/lib/jobs/queue";
import { triggerJobProcessing } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { takeCompletedUpload } from "@/lib/uploads/sessions";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

/** Defaults for a PDF import when the client sends no `pdf` block. */
const PDF_DEFAULTS = { scale: 1.5, maxWidth: 1600 } as const;

export const POST = withAuth(
  { params: paramsSchema, body: importChapterSchema },
  async ({ user, params, body }) => {
    const series = await prisma.series.findUnique({
      where: { id: params.id },
      select: { id: true, visibility: true, isAdult: true, createdById: true },
    });
    if (!series) throw notFound("Series");
    assertCanEditSeries(user, series);

    if (body.kind !== "images" && body.uploadIds.length !== 1) {
      throw badRequest(`A ${body.kind} import takes exactly one upload`);
    }

    // Throws 404 (missing / not yours) or 409 (not completed) before enqueuing.
    const uploads = [];
    for (const uploadId of body.uploadIds) {
      uploads.push(await takeCompletedUpload(user.id, uploadId));
    }

    const shared = {
      seriesId: series.id,
      title: body.title,
      number: body.number ?? null,
      volume: body.volume ?? null,
    };

    const job =
      body.kind === "pdf"
        ? await enqueueJob({
            kind: "PDF_IMPORT",
            seriesId: series.id,
            requestedById: user.id,
            config: {
              ...shared,
              uploadId: body.uploadIds[0],
              // The PDF handler accepts an explicit path so it never has to
              // guess where the uploads module keeps a completed file.
              uploadPath: uploads[0]?.path,
              scale: body.pdf?.scale ?? PDF_DEFAULTS.scale,
              maxWidth: body.pdf?.maxWidth ?? PDF_DEFAULTS.maxWidth,
            },
          })
        : await enqueueJob({
            kind: "MANUAL_UPLOAD",
            seriesId: series.id,
            requestedById: user.id,
            config: { ...shared, uploadIds: body.uploadIds, kind: body.kind },
          });

    triggerJobProcessing();
    return jsonResponse({ jobId: job.id } satisfies EnqueuedJobResponse, { status: 202 });
  },
);
