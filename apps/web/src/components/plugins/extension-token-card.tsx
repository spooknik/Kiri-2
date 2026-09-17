"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Spinner } from "@/components/ui";
import { useExtensionToken } from "@/hooks/use-plugins";

/**
 * Read-only, click-to-copy field for a value the admin pastes elsewhere
 * (the extension's options page). A small local copy of
 * `src/components/admin/invite-url-field.tsx` parameterised with a label —
 * that component hardcodes "Invite link" as its accessible name, which
 * doesn't fit a token/URL field, and it isn't owned by this phase.
 */
function CopyField({ label, value }: { label: string; value: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      } else {
        throw new Error("Clipboard API unavailable");
      }
    } catch {
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.select();
        try {
          setCopied(document.execCommand("copy"));
        } catch {
          setCopied(false);
        }
      }
    } finally {
      window.setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          readOnly
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="font-mono text-xs"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => void handleCopy()}
          aria-label={`Copy ${label.toLowerCase()}`}
          className="shrink-0"
        >
          {copied ? (
            <Check className="h-4 w-4 text-success" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </div>
  );
}

/**
 * Admin card explaining and configuring the Kiri Cookie Bridge browser
 * extension: the ingest/hosts URLs and the bearer token it needs, derived
 * from `APP_SECRET` server-side.
 */
export function ExtensionTokenCard() {
  const { data, isPending, isError, error } = useExtensionToken();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cookie bridge extension</CardTitle>
        <p className="text-sm text-muted">
          Install the Kiri Cookie Bridge browser extension (<code>extension/</code> in the
          repository — see <code>extension/README.md</code>) so visiting a Cloudflare-gated site
          automatically sends its cookies to this instance, instead of pasting them by hand on each
          series.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isPending ? (
          <Spinner label="Loading token" />
        ) : isError || !data ? (
          <p className="text-sm text-danger">
            Couldn&apos;t load the extension token. {error?.message}
          </p>
        ) : (
          <>
            <CopyField label="Hosts endpoint" value={data.hostsUrl} />
            <CopyField label="Ingest endpoint" value={data.ingestUrl} />
            <CopyField label="Token" value={data.token} />
            <p className="text-xs text-muted">
              Paste the instance URL and this token into the extension&apos;s options page, then use
              &quot;Test connection&quot;. The token is derived from <code>APP_SECRET</code> and
              rotates if that value changes.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
