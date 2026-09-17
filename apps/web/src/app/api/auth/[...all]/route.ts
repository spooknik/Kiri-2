/**
 * better-auth's own endpoints: /api/auth/sign-in/email, /sign-up/email,
 * /sign-out, /get-session, the admin plugin routes, and so on.
 *
 * The sibling static routes (/api/auth/cf, /api/auth/claim-invite) take
 * precedence over this catch-all, which is how Kiri adds its two custom
 * sign-in paths without forking the router.
 */
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/server";

export const { GET, POST } = toNextJsHandler(auth);
