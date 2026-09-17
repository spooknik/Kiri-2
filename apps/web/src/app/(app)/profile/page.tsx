import { ProfileView } from "@/components/profile/profile-view";
import { requireUser } from "@/lib/auth/session";

export default async function ProfilePage() {
  await requireUser();
  return <ProfileView />;
}
