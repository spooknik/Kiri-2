/**
 * GET /api/pages/:id/image — serve one page image from the content store.
 *
 * Page bytes are private: a PRIVATE or adult series must not leak its artwork,
 * so every single request re-checks `canViewSeries` (a page id is guessable in
 * exactly the same way a series id is). The path is rebuilt from the series id
 * and the chapter slug through the store helpers, so a `Page.file` column that
 * somehow holds `../../secrets` still resolves inside the chapter directory.
 *
 * The URL is stable for the life of the page row and the body is immutable
 * (an optimiser pass writes a new file and a new hash, and the ETag moves with
 * it), which is what lets the service worker cache pages `CacheFirst`.
 *
 * The Content-Type is *not* whatever the manifest claimed: `Page.mime` is a
 * plugin-controlled string, and echoing `text/html` back to a browser from an
 * authenticated same-origin URL is a stored XSS. Only the handful of image
 * types in {@link servableImageMime} are served inline; anything else is an
 * `application/octet-stream` download, and `nosniff` covers the rest.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { notFound, withAuth } from "@/lib/api";
import { assertCanViewSeries } from "@/lib/authz";
import { servableImageMime } from "@/lib/content/images";
import { chapterFilePath } from "@/lib/content/store";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

const CACHE_CONTROL = "private, max-age=31536000, immutable";

export const GET = withAuth({ params: paramsSchema }, async ({ req, user, params }) => {
  const page = await prisma.page.findUnique({
    where: { id: params.id },
    select: {
      file: true,
      mime: true,
      sha256: true,
      chapter: {
        select: {
          slug: true,
          seriesId: true,
          series: { select: { visibility: true, isAdult: true, createdById: true } },
        },
      },
    },
  });
  if (!page) throw notFound("Page");
  assertCanViewSeries(user, page.chapter.series);

  let filePath: string;
  try {
    filePath = chapterFilePath(page.chapter.seriesId, page.chapter.slug, page.file);
  } catch {
    // An unusable file name is a broken row, not a server error.
    throw notFound("Page image");
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    // The row says there is an image but the file is gone (pruned volume,
    // restored database): a 404 lets the reader show its placeholder.
    throw notFound("Page image");
  }

  // A content hash is a strong validator; size+mtime is the weak fallback.
  const etag = page.sha256
    ? `"${page.sha256}"`
    : `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;

  const mime = servableImageMime(page.mime, page.file);
  const headers: Record<string, string> = {
    "Content-Type": mime ?? "application/octet-stream",
    "Cache-Control": CACHE_CONTROL,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (mime === null) {
    // Unknown or untrusted type: hand it over as a file, never as a document.
    headers["Content-Disposition"] = "attachment";
  }

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const stream = Readable.toWeb(
    createReadStream(filePath),
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: { ...headers, "Content-Length": String(info.size) },
  });
});
