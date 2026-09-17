import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover disabled:bg-primary/50",
  secondary:
    "border border-card-border bg-surface-2 text-foreground hover:bg-card-border/60 disabled:opacity-50",
  ghost: "bg-transparent text-foreground hover:bg-surface-2 disabled:opacity-50",
  danger: "bg-danger text-white hover:bg-danger/90 disabled:bg-danger/50",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 min-w-9 gap-1.5 px-3 text-sm",
  md: "h-11 min-w-11 gap-2 px-4 text-sm",
  lg: "h-12 min-w-12 gap-2 px-6 text-base",
};

const baseClasses =
  "focus-ring inline-flex select-none items-center justify-center rounded-md font-medium transition-colors disabled:pointer-events-none disabled:cursor-not-allowed";

type SharedProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables interaction. */
  loading?: boolean;
  className?: string;
  children?: ReactNode;
};

export type ButtonAsButtonProps = SharedProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & {
    href?: undefined;
  };

export type ButtonAsLinkProps = SharedProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children" | "href"> & {
    /** Renders a Next.js `<Link>` instead of a `<button>`. */
    href: string;
  };

export type ButtonProps = ButtonAsButtonProps | ButtonAsLinkProps;

/**
 * Button with hand-rolled variant/size maps (no CVA dependency). Renders a
 * Next `<Link>` when `href` is passed, otherwise a native `<button>`.
 */
export function Button(props: ButtonProps) {
  const { variant = "primary", size = "md", loading = false, className, children, ...rest } = props;
  const classes = cn(baseClasses, variantClasses[variant], sizeClasses[size], className);

  if (rest.href !== undefined) {
    const { href, ...linkRest } = rest;
    return (
      <Link href={href} className={classes} aria-disabled={loading || undefined} {...linkRest}>
        {loading ? <Spinner size="sm" className="text-current" /> : null}
        {children}
      </Link>
    );
  }

  return (
    <button
      className={classes}
      disabled={loading || rest.disabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size="sm" className="text-current" /> : null}
      {children}
    </button>
  );
}
