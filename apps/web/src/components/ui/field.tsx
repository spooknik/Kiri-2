import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Label } from "./label";

export type FieldProps = {
  /** Visible label text. Omit for a control that renders its own label (e.g. Checkbox). */
  label?: string;
  /** id of the control; also used to derive the error/help text ids. */
  htmlFor: string;
  error?: string;
  help?: string;
  required?: boolean;
  className?: string;
  /** A single form control element (Input, Select, Textarea, ...). */
  children: ReactNode;
};

/**
 * Composes a label with a form control and error/help text, wiring up
 * `id`, `aria-describedby`, and `aria-invalid` on the control automatically.
 */
export function Field({ label, htmlFor, error, help, required, className, children }: FieldProps) {
  const errorId = error ? `${htmlFor}-error` : undefined;
  const helpId = help ? `${htmlFor}-help` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(" ") || undefined;

  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: htmlFor,
        "aria-describedby": describedBy,
        "aria-invalid": Boolean(error) || undefined,
      })
    : children;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <Label htmlFor={htmlFor} required={required}>
          {label}
        </Label>
      ) : null}
      {control}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className="text-sm text-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}
