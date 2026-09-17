/** GET /api/admin/jobs — every job on the instance, newest first. */
import { withAuth } from "@/lib/api";
import { jobsQuerySchema } from "@/lib/contracts";
import { listAllJobs } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

export const GET = withAuth({ role: "admin", query: jobsQuerySchema }, ({ query }) =>
  listAllJobs(query),
);
