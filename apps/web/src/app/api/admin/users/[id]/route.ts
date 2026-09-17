/** PATCH /api/admin/users/:id — change a role, ban or unban. */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { updateAdminUser } from "@/lib/admin/users";
import { updateUserSchema } from "@/lib/contracts/admin";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const PATCH = withAuth(
  { role: "admin", body: updateUserSchema, params: paramsSchema },
  ({ user, body, params }) => updateAdminUser(user, params.id, body),
);
