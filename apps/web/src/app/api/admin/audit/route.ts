/** GET /api/admin/audit — the audit trail, newest first, cursor paginated. */
import { withAuth } from "@/lib/api";
import { listAudit } from "@/lib/audit";
import { auditQuerySchema } from "@/lib/contracts/admin";

export const dynamic = "force-dynamic";

export const GET = withAuth({ role: "admin", query: auditQuerySchema }, ({ query }) =>
  listAudit(query),
);
