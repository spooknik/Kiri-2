"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ClipboardList } from "lucide-react";
import { Button, EmptyState, Spinner } from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";
import { useAdminAudit } from "@/hooks/use-admin";
import type { AuditEntryView } from "@/lib/contracts";

export function AuditLog() {
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useAdminAudit();
  const entries = data?.pages.flatMap((page) => page.items) ?? [];

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading audit log" />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load the audit log"
        description="Try refreshing the page."
      />
    );
  }

  if (entries.length === 0) {
    return <EmptyState icon={ClipboardList} title="No audit events yet" />;
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <AuditRow key={entry.id} entry={entry} />
      ))}
      {hasNextPage ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void fetchNextPage()}
          loading={isFetchingNextPage}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntryView }) {
  const [expanded, setExpanded] = useState(false);
  const hasMetadata = Object.keys(entry.metadata).length > 0;

  return (
    <div className="rounded-lg border border-card-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {entry.actor?.displayName ?? "System"}{" "}
            <span className="font-normal text-muted">{entry.action}</span>
          </p>
          <p className="text-xs text-muted">
            {entry.targetType}
            {entry.targetId ? ` · ${entry.targetId}` : ""}
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted">{formatRelativeTime(entry.createdAt)}</span>
      </div>
      {hasMetadata ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="focus-ring flex items-center gap-1 text-xs font-medium text-primary"
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Details
          </button>
          {expanded ? (
            <pre className="mt-1 overflow-x-auto rounded-md bg-surface-2 p-2 text-[11px] text-foreground">
              {JSON.stringify(entry.metadata, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
