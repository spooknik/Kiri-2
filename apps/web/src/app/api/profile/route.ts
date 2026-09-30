/**
 * GET   /api/profile — the signed-in user's settings and reading stats.
 * PATCH /api/profile — update display name and preferences.
 *
 * Passwords and sessions are handled by better-auth's own endpoints.
 */
import { withAuth } from "@/lib/api";
import { refreshSessionCache } from "@/lib/auth/session";
import { updateProfileSchema } from "@/lib/contracts/profile";
import { getProfile, updateProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";

export const GET = withAuth({}, ({ user }) => getProfile(user.id));

export const PATCH = withAuth({ body: updateProfileSchema }, async ({ user, body }) => {
  const profile = await updateProfile(user.id, body);
  // showAdult and displayName ride in the session cookie cache; refresh it so
  // the very next library request already filters with the new value.
  if (body.showAdult !== undefined || body.displayName !== undefined) {
    await refreshSessionCache();
  }
  return profile;
});
