/** GET /api/admin/users — every account with its series counts. */
import { withAuth } from "@/lib/api";
import { listAdminUsers } from "@/lib/admin/users";

export const dynamic = "force-dynamic";

export const GET = withAuth({ role: "admin" }, () => listAdminUsers());
