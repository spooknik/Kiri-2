/**
 * GET /api/jobs — the jobs one user may see: the ones they started, plus every
 * job on a series they can view. Admins get the whole instance from
 * /api/admin/jobs instead.
 */
import { withAuth } from "@/lib/api";
import { jobsQuerySchema } from "@/lib/contracts";
import { listJobs } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

export const GET = withAuth({ query: jobsQuerySchema }, ({ user, query }) => listJobs(user, query));
