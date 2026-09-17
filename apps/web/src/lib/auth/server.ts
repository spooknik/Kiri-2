/**
 * The better-auth instance. Server only — it pulls in Prisma and the Node
 * crypto stack. Client components use src/lib/auth/client.ts instead.
 *
 * Notes on the configuration:
 * - The Prisma adapter addresses models by better-auth's default lower-case
 *   names ("user", "session", …), which are exactly the Prisma client
 *   properties generated from our `User`/`Session`/`Account`/`Verification`
 *   models, so no `modelName` overrides are needed.
 * - Kiri profile columns are declared as `user.additionalFields`. Only
 *   `displayName` accepts input (the sign-up form sets it); the rest are
 *   `input: false` so a crafted sign-up body cannot, say, grant itself
 *   `showAdult` or clear `mustSetPassword`.
 * - Registration gating lives in `databaseHooks.user.create.before`, which runs
 *   for every user-creating endpoint, and the matching `after` hook records who
 *   redeemed the invite.
 * - better-auth's own rate limiter is off. It keys on an IP taken from proxy
 *   headers it cannot verify, so it is both bypassable (a spoofed
 *   `x-forwarded-for` mints a fresh bucket per request) and a lockout risk
 *   (with no such header the whole instance shares one bucket). `hooks.before`
 *   applies src/lib/auth/rate-limits.ts to the credential endpoints instead.
 */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import {
  INVITE_TOKEN_FIELD,
  RegistrationDeniedError,
  resolveSignUp,
} from "@/lib/auth/registration";
import { limitAuthAttempt, retryAfterSeconds } from "@/lib/auth/rate-limits";
import { getEnv } from "@/lib/env";
import { attachInviteRedeemer, hashInviteToken } from "@/lib/invites";
import { prisma } from "@/lib/prisma";

const env = getEnv();
const baseURL = env.PUBLIC_URL.replace(/\/+$/, "");
const isProduction = env.NODE_ENV === "production";

/** Path of the email/password sign-up endpoint, relative to `basePath`. */
const SIGN_UP_PATH = "/sign-up/email";

/**
 * Endpoints that accept a credential and are therefore worth guessing at.
 * Paths are relative to `basePath`, exactly as `ctx.path` reports them.
 */
const RATE_LIMITED_PATHS = new Set([
  SIGN_UP_PATH,
  "/sign-in/email",
  "/change-password",
  "/forget-password",
]);

/** Narrow an endpoint context's `headers` (typed loosely upstream) to Headers. */
function asHeaders(value: unknown): Headers | null {
  return value instanceof Headers ? value : null;
}

/** The email an auth request is about, when its body carries one. */
function readEmail(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)["email"];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readInviteToken(context: { body?: unknown } | null | undefined): string | null {
  const body = context?.body;
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[INVITE_TOKEN_FIELD];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const auth = betterAuth({
  appName: "Kiri",
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: env.APP_SECRET,
  baseURL,
  // Only our own origin may drive the auth endpoints.
  trustedOrigins: [baseURL],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    // No SMTP requirement for a self-hosted instance.
    requireEmailVerification: false,
    autoSignIn: true,
  },
  user: {
    additionalFields: {
      displayName: { type: "string", required: true, input: true },
      showAdult: { type: "boolean", required: false, input: false },
      showSpoilers: { type: "boolean", required: false, input: false },
      optimizerFormat: { type: "string", required: false, input: false },
      optimizerQuality: { type: "number", required: false, input: false },
      mustSetPassword: { type: "boolean", required: false, input: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: true,
      // Short on purpose: role and profile edits must show up quickly.
      maxAge: 60,
    },
  },
  advanced: {
    // Self-hosting over plain http on a LAN is supported, so the `__Secure-`
    // prefix is only used when the public origin is actually https.
    useSecureCookies: isProduction && baseURL.startsWith("https://"),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          // Only gate the public sign-up endpoint. Other creation paths
          // (the Cloudflare Access bridge, the admin plugin, the V1 importer)
          // do their own authorization.
          if (!context || context.path !== SIGN_UP_PATH) return;
          const email = typeof user.email === "string" ? user.email : "";
          const decision = await resolveSignUp({
            email,
            inviteToken: readInviteToken(context),
          }).catch((error: unknown) => {
            // Surface the reason to the client instead of better-auth's
            // generic "failed to create user".
            throw toAPIError(error);
          });
          return {
            data: {
              ...user,
              role: decision.role,
              // Accounts created with a password never need to set one later.
              mustSetPassword: false,
              displayName:
                typeof user.displayName === "string" && user.displayName.trim()
                  ? user.displayName.trim()
                  : user.name,
            },
          };
        },
        after: async (user, context) => {
          if (!context || context.path !== SIGN_UP_PATH) return;
          const rawToken = readInviteToken(context);
          if (!rawToken) return;
          await attachInviteRedeemer(hashInviteToken(rawToken), user.id);
        },
      },
    },
  },
  // See the module docstring: replaced by hooks.before + src/lib/auth/rate-limits.ts.
  rateLimit: { enabled: false },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!RATE_LIMITED_PATHS.has(ctx.path)) return;
      const decision = limitAuthAttempt({
        scope: ctx.path,
        email: readEmail(ctx.body),
        headers: asHeaders(ctx.headers) ?? ctx.request?.headers ?? null,
      });
      if (decision.allowed) return;
      throw new APIError(
        "TOO_MANY_REQUESTS",
        {
          code: "RATE_LIMITED",
          message: "Too many attempts. Please wait a moment and try again.",
        },
        { "Retry-After": String(retryAfterSeconds(decision.retryAfterMs)) },
      );
    }),
  },
  plugins: [admin({ defaultRole: "member", adminRoles: ["admin"] }), nextCookies()],
});

export type Auth = typeof auth;

/**
 * Turn a {@link RegistrationDeniedError} thrown inside a database hook into the
 * 403 better-auth reports to the client. Anything else keeps its own shape.
 */
function toAPIError(error: unknown): unknown {
  if (error instanceof RegistrationDeniedError) {
    return new APIError("FORBIDDEN", { code: error.code, message: error.message });
  }
  return error;
}
