"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Smartphone } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
  useToast,
} from "@/components/ui";
import { authClient } from "@/lib/auth/client";
import { formatRelativeTime } from "@/lib/format";

// Session listing isn't part of the profile/admin/notifications JSON
// contracts (it's a better-auth client concept), so this key intentionally
// lives here rather than in the shared `queryKeys` module.
const SESSIONS_QUERY_KEY = ["auth", "sessions"] as const;

interface SessionRecord {
  id: string;
  token: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string | Date;
  expiresAt: string | Date;
}

export function SessionsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const session = authClient.useSession();
  const currentToken = session.data?.session?.token;

  const { data, isLoading, isError } = useQuery<SessionRecord[]>({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: async () => {
      const result = await authClient.listSessions();
      if (result.error) {
        throw new Error(result.error.message ?? "Couldn't load sessions");
      }
      return (result.data ?? []) as SessionRecord[];
    },
  });

  async function revoke(token: string) {
    const result = await authClient.revokeSession({ token });
    if (result.error) {
      toast({
        title: "Couldn't sign out that session",
        description: result.error.message,
        tone: "danger",
      });
      return;
    }
    toast({ title: "Session signed out", tone: "success" });
    void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  }

  async function revokeOthers() {
    const result = await authClient.revokeOtherSessions();
    if (result.error) {
      toast({
        title: "Couldn't sign out other sessions",
        description: result.error.message,
        tone: "danger",
      });
      return;
    }
    toast({ title: "Signed out everywhere else", tone: "success" });
    void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  }

  const sessions = data ?? [];
  const otherSessionsCount = sessions.filter((item) => item.token !== currentToken).length;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Devices currently signed in to your account.</CardDescription>
        </div>
        {otherSessionsCount > 0 ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => void revokeOthers()}>
            Sign out everywhere
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {isLoading ? (
          <div className="flex justify-center py-4">
            <Spinner label="Loading sessions" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted">Couldn&apos;t load sessions.</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted">No active sessions.</p>
        ) : (
          sessions.map((item) => {
            const isCurrent = item.token === currentToken;
            return (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-card-border p-3"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.userAgent ? summarizeUserAgent(item.userAgent) : "Unknown device"}
                      {isCurrent ? (
                        <span className="ml-2 text-xs font-normal text-primary">This device</span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {item.ipAddress ? `${item.ipAddress} · ` : ""}
                      Active {formatRelativeTime(item.createdAt)}
                    </p>
                  </div>
                </div>
                {!isCurrent ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Sign out this session"
                    onClick={() => void revoke(item.token)}
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function summarizeUserAgent(ua: string): string {
  if (/iphone|ipad/i.test(ua)) return "iOS device";
  if (/android/i.test(ua)) return "Android device";
  if (/macintosh/i.test(ua)) return "Mac";
  if (/windows/i.test(ua)) return "Windows PC";
  if (/linux/i.test(ua)) return "Linux";
  return "Browser session";
}
