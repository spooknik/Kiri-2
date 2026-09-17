/**
 * GET /api/series/:id/cover — serve the stored cover.
 *
 * Covers live in the content store, not in `public/`, because visibility rules
 * apply: a private or adult series must not leak its artwork. The response is
 * therefore `private` in the cache, revalidated by an ETag derived from the
 * file's size and mtime, and the URL carries a `?v=` stamp from the series'
 * updatedAt so a replaced cover is picked up immediately.
 */
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { notFound, withAuth } from "@/lib/api";
import { assertCanViewSeries } from "@/lib/authz";
import { getCoverPath } from "@/lib/cover-storage";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withAuth({ params: paramsSchema }, async ({ req, user, params }) => {
  const series = await prisma.series.findUnique({
    where: { id: params.id },
    select: { id: true, coverFile: true, visibility: true, isAdult: true, createdById: true },
  });
  if (!series) throw notFound("Series");
  assertCanViewSeries(user, series);
  if (!series.coverFile) throw notFound("Cover");

  const filePath = getCoverPath(series.id, series.coverFile);
  let info;
  try {
    info = await stat(filePath);
  } catch {
    // The column says there is a cover but the file is gone (restored DB,
    // pruned volume): a 404 lets the client fall back to the placeholder.
    throw notFound("Cover");
  }

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    // Always WebP: storeCoverFromBuffer re-encodes whatever arrived. `nosniff`
    // makes sure a browser takes that at face value.
    "Content-Type": "image/webp",
    "Cache-Control": "private, max-age=86400",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const bytes = await readFile(filePath);
  return new Response(new Uint8Array(bytes), {
    headers: { ...headers, "Content-Length": String(bytes.byteLength) },
  });
});
