"use client";

import { useState } from "react";
import { FilterChip } from "@/components/library/filter-chip";
import { useAdminJobs } from "@/hooks/use-jobs";
import type { JobsQuery } from "@/lib/contracts/content";
import { JobList } from "./job-list";
import { RunnerStatusCard } from "./runner-status-card";

type FilterValue = "active" | "FAILED" | "all";

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "FAILED", label: "Failed" },
  { value: "all", label: "All" },
];

/** `/admin/jobs`: runner status + filterable, paginated job list, admin-only (gated by the /admin layout). */
export function AdminJobsView() {
  const [filter, setFilter] = useState<FilterValue>("active");
  const status: JobsQuery["status"] | undefined = filter === "all" ? undefined : filter;
  const query = useAdminJobs({ status });
  const jobs = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <RunnerStatusCard />

      <div className="scrollbar-hide flex items-center gap-1.5 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            selected={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </FilterChip>
        ))}
      </div>

      <JobList
        jobs={jobs}
        isLoading={query.isLoading}
        isError={query.isError}
        hasNextPage={Boolean(query.hasNextPage)}
        isFetchingNextPage={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </div>
  );
}
