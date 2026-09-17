import { Card } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";
import type { MemberProgress } from "@/lib/contracts/series";
import { StatusBadge } from "./status-badge";

export interface MembersCardProps {
  members: MemberProgress[];
}

/** Book-club side-by-side progress: every tracking member's status/chapter/rating. */
export function MembersCard({ members }: MembersCardProps) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-semibold text-foreground">Members</h2>
      <ul className="flex flex-col divide-y divide-card-border">
        {members.map((member) => (
          <li
            key={member.user.id}
            className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {member.user.displayName}
              </p>
              <p className="text-xs text-muted">Updated {formatRelativeTime(member.updatedAt)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3 text-sm">
              <span className="tabular-nums text-muted">Ch. {member.currentChapter}</span>
              {member.rating ? (
                <span className="tabular-nums text-warning">{member.rating}/10</span>
              ) : null}
              <StatusBadge status={member.status} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
