import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid ?? props["aria-invalid"]}
      className={cn(
        "focus-ring min-h-24 w-full min-w-0 rounded-md border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50",
        invalid ? "border-danger" : "border-card-border",
        className,
      )}
      {...props}
    />
  );
});
