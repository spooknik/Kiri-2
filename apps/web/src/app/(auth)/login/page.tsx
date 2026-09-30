import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { RegistrationMode } from "@/generated/prisma/client";
import { safeNext } from "@/lib/auth/safe-next";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    redirect("/setup");
  }
  const params = await searchParams;
  // `next` comes straight off the query string and ends up in router.replace()
  // and the Cloudflare button's href, so it is validated before it is handed
  // to the client component.
  const nextParam = typeof params["next"] === "string" ? params["next"] : undefined;
  const passwordReset = params["reset"] === "1";
  const settings = await getAppSettings();
  const env = getEnv();

  return (
    <>
      {passwordReset ? (
        <p
          className="mb-4 rounded-md bg-success-light px-3 py-2 text-sm text-success"
          role="status"
        >
          Your password was changed. Sign in with the new one.
        </p>
      ) : null}
      <LoginForm next={safeNext(nextParam)} cloudflareEnabled={env.AUTH_CF_ACCESS === "1"} />
      <p className="mt-4 text-center text-xs text-muted">
        Forgot your password? Ask an admin for a reset link.
      </p>
      {settings.registrationMode === RegistrationMode.OPEN ? (
        <p className="mt-6 text-center text-sm text-secondary">
          No account yet?{" "}
          <Link className="font-medium text-primary hover:underline" href="/register">
            Create one
          </Link>
        </p>
      ) : null}
    </>
  );
}
