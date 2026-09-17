"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/cn";

export type InviteUrlFieldProps = {
  url: string;
  className?: string;
};

/**
 * Read-only, click-to-copy field for a one-time invite URL. Prefers the
 * async Clipboard API; falls back to selecting the input's text and
 * `document.execCommand("copy")` when it isn't available (e.g. non-secure
 * context, older WebView).
 */
export function InviteUrlField({ url, className }: InviteUrlFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
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
    <div className={cn("flex items-center gap-2", className)}>
      <Input
        ref={inputRef}
        readOnly
        value={url}
        aria-label="Invite link"
        onFocus={(event) => event.currentTarget.select()}
        className="font-mono text-xs"
      />
      <Button
        type="button"
        variant="secondary"
        onClick={() => void handleCopy()}
        aria-label="Copy invite link"
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
  );
}
