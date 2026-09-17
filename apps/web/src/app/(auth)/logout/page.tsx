import type { Metadata } from "next";
import { LogoutRunner } from "./logout-runner";

export const metadata: Metadata = { title: "Signing out" };

export default function LogoutPage() {
  return <LogoutRunner />;
}
