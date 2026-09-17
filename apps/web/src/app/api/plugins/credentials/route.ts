/**
 * POST /api/plugins/credentials — cookie ingest from the Kiri Cookie Bridge.
 *
 * The extension posts `{ host, cookie, userAgent }` whenever it sees a fresh
 * cookie on a host Kiri asked about. The host decides which plugin owns it; an
 * unknown host is a 404 so the extension stops sending for that domain.
 *
 * Token first, body second: an unauthenticated caller gets 401 without the
 * server telling it anything about the expected shape.
 */
import { badRequest, notFound, unauthorized, withPublic } from "@/lib/api";
import { extensionCredentialSchema } from "@/lib/contracts/plugins";
import { ingestPluginCredential } from "@/lib/plugins/credentials";
import { hasValidExtensionToken } from "@/lib/plugins/extension-token";

export const dynamic = "force-dynamic";

export const POST = withPublic({}, async ({ req }) => {
  if (!hasValidExtensionToken(req.headers)) {
    throw unauthorized("A valid Kiri extension token is required");
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  const parsed = extensionCredentialSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(
      "Invalid credential",
      parsed.error.issues.map((issue) => issue.message),
    );
  }

  const stored = await ingestPluginCredential(parsed.data);
  if (!stored) throw notFound("Plugin for that host");

  return {
    pluginId: stored.pluginId,
    pluginName: stored.pluginName,
    host: stored.host,
    clearedSources: stored.clearedSources,
  };
});
