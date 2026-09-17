import { z } from "zod";

/**
 * Server environment, validated lazily on first use so `next build` (which
 * has no secrets) never trips over missing runtime configuration.
 */
const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_SECRET: z
    .string()
    .min(32, "APP_SECRET must be at least 32 characters (use `openssl rand -base64 48`)"),
  // Previous secret during rotation; credentials encrypted with it still decrypt.
  APP_SECRET_PREVIOUS: z.string().min(32).optional(),
  PUBLIC_URL: z.url().default("http://localhost:3000"),
  DATA_ROOT: z.string().default("./data"),
  AUTH_CF_ACCESS: z.enum(["0", "1"]).default("0"),
  AUTH_CF_TRUST_HEADER: z.enum(["0", "1"]).default("0"),
  /**
   * `1` when a reverse proxy (nginx, Traefik, Cloudflare) sits in front of the
   * app, so client IPs may be read from `cf-connecting-ip` / `x-forwarded-for`
   * for rate limiting. Left at `0`, those headers are ignored — a client that
   * can reach the app directly could otherwise mint a fresh rate-limit bucket
   * per request just by varying the header.
   */
  AUTH_TRUST_PROXY: z.enum(["0", "1"]).default("0"),
  CF_ACCESS_TEAM_DOMAIN: z.string().optional(),
  CF_ACCESS_AUD: z.string().optional(),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  JOB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(2 * 60 * 60 * 1000),
  KIRI_PLUGIN_SANDBOX: z.enum(["on", "warn", "off"]).default("warn"),
});

/**
 * Cross-field rules. Skipped during `next build`, which parses placeholder
 * values (see {@link BUILD_PHASE_PLACEHOLDERS}) rather than real configuration.
 */
const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (isNextBuildPhase()) return;
  if (env.AUTH_CF_TRUST_HEADER === "1" && !env.PUBLIC_URL.startsWith("https://")) {
    ctx.addIssue({
      code: "custom",
      path: ["AUTH_CF_TRUST_HEADER"],
      message:
        "AUTH_CF_TRUST_HEADER=1 trusts the cf-access-authenticated-user-email header, which any client that can reach this instance directly may set. It is only safe when every request arrives through Cloudflare over TLS, so PUBLIC_URL must be an https:// origin. Either set PUBLIC_URL to your https origin, or drop the header mode and verify the Access JWT with CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD.",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * `next build` imports route modules while collecting page data, which
 * constructs the Prisma client and better-auth at module scope. Nothing
 * connects during the build, so missing required values are filled with
 * clearly-labelled placeholders in that phase only. At runtime the real
 * validation applies unchanged.
 */
const BUILD_PHASE_PLACEHOLDERS: Partial<Record<keyof Env, string>> = {
  DATABASE_URL: "postgresql://build:build@build-placeholder.invalid:5432/build",
  APP_SECRET: "next-build-phase-placeholder-secret-never-used-at-runtime",
  PUBLIC_URL: "http://localhost:3000",
};

function isNextBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

export function getEnv(): Env {
  if (cached) return cached;
  const source: Record<string, string | undefined> = isNextBuildPhase()
    ? { ...BUILD_PHASE_PLACEHOLDERS, ...stripUndefined(process.env) }
    : process.env;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment:\n  ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

function stripUndefined(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

/** Test helper: forget the cached environment. */
export function resetEnvCache(): void {
  cached = null;
}
