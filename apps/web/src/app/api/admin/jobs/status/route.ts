/**
 * GET /api/admin/jobs/status — is the worker alive, how deep is the queue.
 * `running` reflects this process; `lastHeartbeatAt` is what proves it.
 */
import { withAuth } from "@/lib/api";
import { getRunnerStatus } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

export const GET = withAuth({ role: "admin" }, () => getRunnerStatus());
