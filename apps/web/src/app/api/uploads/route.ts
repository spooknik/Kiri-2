/**
 * POST /api/uploads — start a chunked upload.
 *
 * The response tells the client the chunk plan (`chunkSize`, `chunkCount`); it
 * then PUTs each chunk to /api/uploads/:id/chunks/:index in any order and
 * finishes with /api/uploads/:id/complete.
 *
 * Creating a session reserves disk, so it is rate limited (20 back-to-back, one
 * more every five seconds — a bulk import of a few dozen files still goes
 * through) on top of the per-user quota `createUploadSession` enforces.
 */
import { jsonResponse, withAuth } from "@/lib/api";
import { createUploadSchema } from "@/lib/contracts";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { createUploadSession } from "@/lib/uploads/sessions";

export const dynamic = "force-dynamic";

export const POST = withAuth({ body: createUploadSchema }, async ({ user, body }) => {
  const gate = checkRateLimit(`uploads:create:${user.id}`, {
    capacity: 20,
    refillPerSecond: 0.2,
  });
  if (!gate.allowed) return rateLimitedResponse(gate.retryAfterMs);
  return jsonResponse(await createUploadSession(user.id, body), { status: 201 });
});
