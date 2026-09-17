/**
 * GET /api/admin/plugins/extension-token — the token and URLs an admin pastes
 * into the Kiri Cookie Bridge extension.
 *
 * The token is derived from APP_SECRET rather than stored, so this endpoint
 * simply re-derives it. Admin-only, and `no-store` so it never lands in a
 * proxy cache.
 */
import { jsonResponse, withAuth } from "@/lib/api";
import { extensionTokenResponse } from "@/lib/plugins/extension-token";

export const dynamic = "force-dynamic";

export const GET = withAuth({ role: "admin" }, () =>
  jsonResponse(extensionTokenResponse(), { headers: { "Cache-Control": "no-store" } }),
);
