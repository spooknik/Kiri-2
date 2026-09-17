/**
 * GET   /api/profile — the signed-in user's settings and reading stats.
 * PATCH /api/profile — update display name and preferences.
 *
 * Passwords and sessions are handled by better-auth's own endpoints.
 */
import { withAuth } from "@/lib/api";
import { updateProfileSchema } from "@/lib/contracts/profile";
import { getProfile, updateProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";

export const GET = withAuth({}, ({ user }) => getProfile(user.id));

export const PATCH = withAuth({ body: updateProfileSchema }, ({ user, body }) =>
  updateProfile(user.id, body),
);
