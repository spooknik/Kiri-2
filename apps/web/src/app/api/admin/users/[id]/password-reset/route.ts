/** POST /api/admin/users/:id/password-reset — mint a one-time reset link for another user. */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { issuePasswordReset } from "@/lib/admin/users";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const POST = withAuth({ role: "admin", params: paramsSchema }, ({ user, params }) =>
  issuePasswordReset(user, params.id),
);
