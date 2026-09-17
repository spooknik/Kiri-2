/**
 * GET /api/plugins/hosts — the host list the Kiri Cookie Bridge extension
 * asks for on install and once a day, so it knows which sites to capture
 * cookies on.
 *
 * Authenticated by the instance's extension token, not by a session: the
 * extension is a background script with no Kiri cookie of its own. That is why
 * this is `withPublic` plus a hand-rolled bearer check.
 */
import { unauthorized, withPublic } from "@/lib/api";
import type { ExtensionHostsResponse } from "@/lib/contracts/plugins";
import { hasValidExtensionToken } from "@/lib/plugins/extension-token";
import { cookieHosts } from "@/lib/plugins/registry";

export const dynamic = "force-dynamic";

export const GET = withPublic({}, async ({ req }): Promise<ExtensionHostsResponse> => {
  if (!hasValidExtensionToken(req.headers)) {
    throw unauthorized("A valid Kiri extension token is required");
  }
  return { hosts: await cookieHosts() };
});
