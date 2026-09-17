import type { BadgeTone } from "@/components/ui";
import type { JobKind, JobStatus } from "@/lib/contracts/content";

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  SOURCE_SYNC: "Source sync",
  SOURCE_VERIFY: "Source verify",
  OPTIMIZE: "Optimize images",
  PDF_IMPORT: "PDF import",
  MANUAL_UPLOAD: "Chapter upload",
  PLUGIN_INSTALL: "Plugin install",
  V1_IMPORT: "V1 import",
  INGEST_MANIFEST: "Ingest manifest",
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const JOB_STATUS_TONE: Record<JobStatus, BadgeTone> = {
  QUEUED: "neutral",
  RUNNING: "primary",
  SUCCEEDED: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
};
