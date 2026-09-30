/**
 * POST /api/cli/password-reset — mint a reset link for any account, including
 * an admin's own. Called only by `reset-password.mjs` from inside the
 * container; authenticated by an APP_SECRET-derived signature
 * (src/lib/auth/cli-signature.ts), not a session, so it is listed in
 * src/lib/auth/public-paths.ts.
 */
import { z } from "zod";
import { badRequest, notFound, unauthorized, withPublic } from "@/lib/api";
import { CLI_SIGNATURE_HEADER, verifyCliRequest } from "@/lib/auth/cli-signature";
import { createPasswordReset } from "@/lib/auth/password-reset";
import { getEnv } from "@/lib/env";
import { normalizeEmail } from "@/lib/invites";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4096;

const bodySchema = z.object({ email: z.email() });

export const POST = withPublic({}, async ({ req }) => {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw badRequest("Request body too large");
  if (!verifyCliRequest(getEnv().APP_SECRET, req.headers.get(CLI_SIGNATURE_HEADER), raw)) {
    throw unauthorized("Invalid or expired CLI signature");
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw badRequest("Body must be JSON");
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) throw badRequest("Expected { email }");

  const user = await prisma.user.findUnique({
    where: { email: normalizeEmail(parsed.data.email) },
    select: { id: true },
  });
  if (!user) throw notFound("User with that email");

  const created = await createPasswordReset({ userId: user.id, actorId: null, via: "cli" });
  return { email: created.email, url: created.url, expiresAt: created.expiresAt.toISOString() };
});
