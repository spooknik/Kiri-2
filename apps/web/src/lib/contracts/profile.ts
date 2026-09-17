/**
 * Profile contract (the signed-in user's own settings). Password changes and
 * session management go through better-auth's client (`changePassword`,
 * `listSessions`, `revokeSession`), not through these routes.
 */
import { z } from "zod";
import type { ReadingStatus } from "./series";

export const OPTIMIZER_FORMATS = ["WEBP"] as const;

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  showAdult: z.boolean().optional(),
  showSpoilers: z.boolean().optional(),
  optimizerFormat: z.enum(OPTIMIZER_FORMATS).optional(),
  optimizerQuality: z.number().int().min(30).max(100).optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export interface ProfileView {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
  showAdult: boolean;
  showSpoilers: boolean;
  optimizerFormat: (typeof OPTIMIZER_FORMATS)[number];
  optimizerQuality: number;
  mustSetPassword: boolean;
  createdAt: string;
  stats: {
    tracked: number;
    byStatus: Record<ReadingStatus, number>;
    created: number;
  };
}
