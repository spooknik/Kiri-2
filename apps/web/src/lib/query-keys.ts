/**
 * TanStack Query keys. Centralised so invalidation stays consistent across
 * features: invalidate `queryKeys.libraryAll` after any series/entry change,
 * `queryKeys.series(id)` for one detail page, etc.
 */
export const queryKeys = {
  libraryAll: ["library"] as const,
  library: (params: Record<string, unknown>) => ["library", params] as const,
  series: (id: string) => ["series", id] as const,
  malSearch: (q: string) => ["mal-search", q] as const,
  notifications: ["notifications"] as const,
  profile: ["profile"] as const,
  admin: {
    users: ["admin", "users"] as const,
    invites: ["admin", "invites"] as const,
    settings: ["admin", "settings"] as const,
    audit: ["admin", "audit"] as const,
  },
} as const;
