"use client";

import { useState, type FormEvent } from "react";
import { Button, Dialog, Field, Input, Textarea, useToast } from "@/components/ui";
import { useClearSourceCredential, useSetSourceCredential } from "@/hooks/use-source";

export interface CredentialDialogProps {
  open: boolean;
  onClose: () => void;
  seriesId: string;
  hasSeriesCookie: boolean;
}

/**
 * "This site needs a browser cookie" paste flow for `SourceSection`'s
 * FAILED/NEEDS_CREDENTIAL state (and the READY state's "manage cookie"
 * shortcut for cookie-gated plugins). `PUT .../source/credential` to save,
 * `DELETE .../source/credential` to remove.
 */
export function CredentialDialog({
  open,
  onClose,
  seriesId,
  hasSeriesCookie,
}: CredentialDialogProps) {
  const { toast } = useToast();
  const setCredential = useSetSourceCredential(seriesId);
  const clearCredential = useClearSourceCredential(seriesId);

  const [cookie, setCookie] = useState("");
  const [userAgent, setUserAgent] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function reset() {
    setCookie("");
    setUserAgent("");
    setFormError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cookie.trim()) {
      setFormError("Paste the cookie header value.");
      return;
    }
    setFormError(null);
    setCredential.mutate(
      { cookie: cookie.trim(), userAgent: userAgent.trim() || null },
      {
        onSuccess: () => {
          toast({ title: "Cookie saved", tone: "success" });
          reset();
          onClose();
        },
        onError: (error) => setFormError(error.message),
      },
    );
  }

  function handleRemove() {
    clearCredential.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Cookie removed", tone: "success" });
        reset();
        onClose();
      },
      onError: (error) =>
        toast({ title: "Couldn't remove cookie", description: error.message, tone: "danger" }),
    });
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Paste a browser cookie"
      description="Some sites gate access behind a Cloudflare challenge. Solve it in your browser (visit the site until it lets you through), then paste the resulting cookie here."
      className="max-w-lg"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Field
          label="Cookie"
          htmlFor="credential-cookie"
          required
          help="The site's cf_clearance value, or the full Cookie header — extra cookies from the same page are fine to include."
        >
          <Textarea
            id="credential-cookie"
            rows={4}
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder="cf_clearance=…; other_cookie=…"
            disabled={setCredential.isPending}
          />
        </Field>
        <Field
          label="User agent (optional)"
          htmlFor="credential-user-agent"
          help="Must match the browser that solved the challenge — cf_clearance is bound to it, so a mismatched User-Agent gets re-challenged. Leave blank to use Kiri's default."
        >
          <Input
            id="credential-user-agent"
            value={userAgent}
            onChange={(e) => setUserAgent(e.target.value)}
            placeholder="Mozilla/5.0 …"
            disabled={setCredential.isPending}
          />
        </Field>

        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          {hasSeriesCookie ? (
            <Button
              type="button"
              variant="ghost"
              className="text-danger"
              onClick={handleRemove}
              loading={clearCredential.isPending}
            >
              Remove cookie
            </Button>
          ) : null}
          <Button type="submit" loading={setCredential.isPending}>
            Save cookie
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
