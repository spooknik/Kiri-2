import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { READING_STATUS_LABELS, type ProfileView, type ReadingStatus } from "@/lib/contracts";

export function StatsCard({ stats }: { stats: ProfileView["stats"] }) {
  const byStatus = Object.entries(stats.byStatus) as [ReadingStatus, number][];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your library</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="rounded-lg bg-surface-2 p-3">
            <p className="text-2xl font-bold text-foreground">{stats.tracked}</p>
            <p className="text-xs text-muted">Tracked</p>
          </div>
          <div className="rounded-lg bg-surface-2 p-3">
            <p className="text-2xl font-bold text-foreground">{stats.created}</p>
            <p className="text-xs text-muted">Created</p>
          </div>
        </div>
        <dl className="flex flex-col gap-1.5">
          {byStatus.map(([status, count]) => (
            <div key={status} className="flex items-center justify-between text-sm">
              <dt className="text-muted">{READING_STATUS_LABELS[status]}</dt>
              <dd className="font-medium text-foreground">{count}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
