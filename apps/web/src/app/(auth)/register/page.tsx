import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { RegistrationMode } from "@/generated/prisma/client";
import { describeInvite, type InviteScreen } from "@/lib/auth/registration";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Create your account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    redirect("/setup");
  }
  const params = await searchParams;
  const token = typeof params["invite"] === "string" ? params["invite"] : "";
  const settings = await getAppSettings();
  const registrationOpen = settings.registrationMode === RegistrationMode.OPEN;

  const screen: InviteScreen | null = token ? await describeInvite(token) : null;

  if (screen?.kind === "claim") {
    return (
      <>
        <p className="mb-4 text-sm text-secondary">
          Your account was imported from Kiri 1. Choose a password to finish setting it up.
        </p>
        <RegisterForm mode="claim" inviteToken={token} email={screen.email} />
        <SignInLink />
      </>
    );
  }

  if (screen?.kind === "invalid" && !registrationOpen) {
    return (
      <>
        <p className="rounded-md bg-danger-light px-3 py-2 text-sm text-danger" role="alert">
          {screen.message}
        </p>
        <SignInLink />
      </>
    );
  }

  if (!screen && !registrationOpen) {
    return (
      <>
        <p className="text-sm text-secondary">
          This instance is invite only. Ask an admin for an invite link.
        </p>
        <SignInLink />
      </>
    );
  }

  return (
    <>
      <RegisterForm
        mode="signup"
        inviteToken={screen?.kind === "signup" ? token : ""}
        email={screen?.kind === "signup" ? screen.email : null}
      />
      <SignInLink />
    </>
  );
}

function SignInLink() {
  return (
    <p className="mt-6 text-center text-sm text-secondary">
      Already have an account?{" "}
      <Link className="font-medium text-primary hover:underline" href="/login">
        Sign in
      </Link>
    </p>
  );
}
