/** PATCH /api/notifications/:id — mark one notification read. */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { markOneRead } from "@/lib/notifications";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const PATCH = withAuth({ params: paramsSchema }, ({ user, params }) =>
  markOneRead(user.id, params.id),
);
