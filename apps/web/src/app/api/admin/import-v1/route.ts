/**
 * POST /api/admin/import-v1 — start a Kiri 1.x import (admin only).
 * GET  /api/admin/import-v1 — the most recent V1_IMPORT job, or null.
 *
 * The V1 connection string is a credential and is never stored in the clear:
 * it is encrypted with `APP_SECRET` here and only decrypted inside the job
 * handler. The request is rejected early when the data directory does not
 * exist, because that mistake is otherwise only discovered minutes into a run.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { badRequest, jsonResponse, withAuth } from "@/lib/api";
import { v1ImportRequestSchema, type V1ImportEnqueued } from "@/lib/contracts/import-v1";
import { encryptSecret } from "@/lib/crypto";
import { enqueueJob } from "@/lib/jobs/queue";
import { triggerJobProcessing } from "@/lib/jobs/runner";
import { jobInclude, toJobView, type JobRow } from "@/lib/jobs/serialize";
import type { JobView } from "@/lib/contracts/content";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function assertDataDir(dataDir: string): Promise<string> {
  const resolved = path.resolve(dataDir);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(resolved);
  } catch {
    throw badRequest(`The data directory ${resolved} does not exist on this server.`);
  }
  if (!info.isDirectory()) {
    throw badRequest(`${resolved} is not a directory.`);
  }
  return resolved;
}

export const GET = withAuth({ role: "admin" }, async (): Promise<JobView | null> => {
  const row = (await prisma.job.findFirst({
    where: { kind: "V1_IMPORT" },
    orderBy: { createdAt: "desc" },
    include: jobInclude,
  })) as JobRow | null;
  return row ? toJobView(row) : null;
});

export const POST = withAuth(
  { role: "admin", body: v1ImportRequestSchema },
  async ({ user, body }) => {
    const dataDir = await assertDataDir(body.dataDir);

    const job = await enqueueJob({
      kind: "V1_IMPORT",
      requestedById: user.id,
      config: {
        databaseUrlEnc: encryptSecret(body.databaseUrl).toString("base64"),
        dataDir,
        mode: body.mode,
        dryRun: body.dryRun,
        ...(body.adminEmail ? { adminEmail: body.adminEmail } : {}),
        importJobs: body.importJobs,
        requestedById: user.id,
      },
    });

    triggerJobProcessing();
    return jsonResponse({ jobId: job.id } satisfies V1ImportEnqueued, { status: 202 });
  },
);
