"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children?: ReactNode;
  className?: string;
};

/**
 * A modal dialog built on the native `<dialog>` element (`showModal`). Gets
 * Escape-to-close, backdrop click-to-close, and focus trapping for free from
 * the browser; we restore focus to the previously focused element on close.
 */
export function Dialog({ open, onClose, title, description, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const lastActiveElement = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open) {
      lastActiveElement.current = document.activeElement as HTMLElement | null;
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const handleClose = () => {
      onClose();
      lastActiveElement.current?.focus?.();
    };
    // Escape fires `cancel` before `close`; let it fall through to the same
    // `close` handler above instead of the browser's default handling.
    const handleCancel = (event: Event) => {
      event.preventDefault();
      dialog.close();
    };
    const handleBackdropClick = (event: MouseEvent) => {
      if (event.target === dialog) {
        dialog.close();
      }
    };

    dialog.addEventListener("close", handleClose);
    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("click", handleBackdropClick);
    return () => {
      dialog.removeEventListener("close", handleClose);
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("click", handleBackdropClick);
    };
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        "m-auto w-[calc(100vw-2rem)] max-w-md rounded-lg border border-card-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/50",
        className,
      )}
    >
      {title || description ? (
        <div className="flex items-start justify-between gap-3 border-b border-card-border p-4">
          <div className="min-w-0">
            {title ? (
              <h2 id={titleId} className="text-base font-semibold">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close dialog"
            className="focus-ring -m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:text-foreground"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </dialog>
  );
}
