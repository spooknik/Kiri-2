/**
 * PUT /api/uploads/:id/chunks/:index — one raw chunk of a chunked upload.
 *
 * The body is `application/octet-stream` and is streamed straight to disk, so
 * this route never buffers a chunk in memory. Chunks may arrive in any order
 * and may be retried; a chunk that is not exactly the size the plan calls for
 * is rejected (413 when it is too big, 400 when it is short).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { badRequest, ApiError, withAuth } from "@/lib/api";
import { UPLOAD_CHUNK_SIZE } from "@/lib/contracts";
import { payloadTooLarge, writeChunk } from "@/lib/uploads/sessions";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  id: z.uuid(),
  index: z.coerce.number().int().min(0).max(100_000),
});

function assertOctetStream(req: NextRequest): void {
  const contentType = req.headers.get("content-type");
  if (contentType && !contentType.toLowerCase().startsWith("application/octet-stream")) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Chunks must be sent as application/octet-stream",
    );
  }
}

/** Reject an over-sized chunk before reading a single byte of it. */
function assertDeclaredSize(req: NextRequest): void {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > UPLOAD_CHUNK_SIZE) {
    throw payloadTooLarge(`A chunk may be at most ${UPLOAD_CHUNK_SIZE} bytes`);
  }
}

export const PUT = withAuth({ params: paramsSchema }, async ({ req, user, params }) => {
  assertOctetStream(req);
  assertDeclaredSize(req);
  if (!req.body) throw badRequest("Chunk body is empty");
  return writeChunk(user.id, params.id, params.index, req.body);
});
