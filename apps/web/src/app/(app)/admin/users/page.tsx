import { UsersTable } from "@/components/admin/users-table";
import { requireUser } from "@/lib/auth/session";

export default async function AdminUsersPage() {
  const user = await requireUser();
  return <UsersTable currentUserId={user.id} />;
}
