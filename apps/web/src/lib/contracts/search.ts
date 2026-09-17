/**
 * GET /api/search/mal?q= — proxied MyAnimeList search through Jikan v4
 * (no API key). Results are normalised so the add-series form can submit a
 * result straight into createSeriesSchema.
 */
import { z } from "zod";
import type { MediaType } from "./series";

export const malSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});
export type MalSearchQuery = z.infer<typeof malSearchQuerySchema>;

export interface MalSearchResult {
  malId: number;
  title: string;
  originalTitle: string | null;
  mediaType: MediaType;
  synopsis: string | null;
  coverUrl: string | null;
  publicationYear: number | null;
  totalChapters: number | null;
  totalVolumes: number | null;
  tags: string[];
  /** MyAnimeList page. */
  url: string;
  /** Set when a visible series with this malId already exists on the instance. */
  existingSeriesId: string | null;
}

export interface MalSearchResponse {
  results: MalSearchResult[];
}
