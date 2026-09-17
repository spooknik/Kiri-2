/**
 * TanStack Query keys for the plugin-management UI and per-series content
 * source. Kept separate from `src/lib/query-keys.ts` and
 * `src/lib/content-query-keys.ts` (owned by other agents, mid-flight in
 * parallel) to avoid merge conflicts. Follows the same convention as those
 * files: invalidate the `*All` root to hit every params variant.
 */
export const pluginQueryKeys = {
  pluginsAll: ["plugins"] as const,
  plugin: (id: string) => ["plugins", id] as const,
  extensionToken: ["plugins", "extension-token"] as const,
  source: (seriesId: string) => ["source", seriesId] as const,
} as const;
