import { withPublic } from "@/lib/api";

/**
 * Public build info. `protocolVersion` is the contract between this server and
 * the offline reader / any external client: bump it only on a breaking change
 * to the JSON API so old clients can refuse to talk to a newer server.
 */
const PROTOCOL_VERSION = 1;

export const dynamic = "force-dynamic";

export const GET = withPublic({}, () => ({
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
  protocolVersion: PROTOCOL_VERSION,
}));
