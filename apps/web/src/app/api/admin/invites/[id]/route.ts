/** DELETE /api/admin/invites/:id — revoke a pending invite (204). */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { revokeInviteById } from "@/lib/admin/invites";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const DELETE = withAuth(
  { role: "admin", params: paramsSchema },
  async ({ user, params }) => {
    await revokeInviteById(user, params.id);
  },
);
