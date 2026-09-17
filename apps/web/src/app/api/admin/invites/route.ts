/**
 * GET  /api/admin/invites — the invite list with creator and redeemer.
 * POST /api/admin/invites — mint one; the response is the only place the
 *                           invite URL (and therefore the raw token) appears.
 */
import { withAuth } from "@/lib/api";
import { createInviteView, listInviteViews } from "@/lib/admin/invites";
import { createInviteSchema } from "@/lib/contracts/admin";

export const dynamic = "force-dynamic";

export const GET = withAuth({ role: "admin" }, () => listInviteViews());

export const POST = withAuth({ role: "admin", body: createInviteSchema }, ({ user, body }) =>
  createInviteView(user, body),
);
