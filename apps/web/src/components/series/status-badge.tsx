import { Badge, type BadgeTone } from "@/components/ui/badge";
import { READING_STATUS_LABELS, type ReadingStatus } from "@/lib/contracts/series";

const STATUS_TONE: Record<ReadingStatus, BadgeTone> = {
  READING: "primary",
  COMPLETED: "success",
  ON_HOLD: "warning",
  DROPPED: "danger",
  PLAN_TO_READ: "neutral",
};

export function StatusBadge({ status }: { status: ReadingStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{READING_STATUS_LABELS[status]}</Badge>;
}
