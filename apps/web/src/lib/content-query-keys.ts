/**
 * TanStack Query keys for the content-management UI (chapters, uploads,
 * jobs, continue-reading). Kept separate from `src/lib/query-keys.ts`
 * (owned by another agent, mid-flight in parallel) to avoid merge
 * conflicts. Follows the same root/params convention as that file:
 * invalidate the `*All` root to hit every params variant, e.g.
 * `queryKeys.libraryAll` vs `queryKeys.library(params)`.
 */
export const contentQueryKeys = {
  chapters: (seriesId: string) => ["chapters", seriesId] as const,
  continueReading: ["continue-reading"] as const,
  jobsAll: ["jobs"] as const,
  jobs: (params: Record<string, unknown>) => ["jobs", params] as const,
  job: (id: string) => ["job", id] as const,
  adminJobsAll: ["admin-jobs"] as const,
  adminJobs: (params: Record<string, unknown>) => ["admin-jobs", params] as const,
  runnerStatus: ["runner-status"] as const,
} as const;
