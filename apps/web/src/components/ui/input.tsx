import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid ?? props["aria-invalid"]}
      className={cn(
        "focus-ring h-11 w-full min-w-0 rounded-md border bg-card px-3 text-sm text-foreground placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50",
        invalid ? "border-danger" : "border-card-border",
        className,
      )}
      {...props}
    />
  );
});
