/**
 * GET /api/series/:id/offline-manifest — the download plan for offline mode.
 *
 * View access to the series is required, exactly like the chapter list; the
 * page-image route re-checks it per request when the bytes are actually
 * fetched. `no-store`, because the manifest is a point-in-time snapshot and a
 * stale copy would send the downloader after page ids that no longer exist.
 */
import { z } from "zod";
import { jsonResponse, withAuth } from "@/lib/api";
import { buildOfflineManifest } from "@/lib/offline/manifest";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withAuth({ params: paramsSchema }, async ({ user, params }) =>
  jsonResponse(await buildOfflineManifest(user, params.id), {
    headers: { "Cache-Control": "no-store" },
  }),
);
