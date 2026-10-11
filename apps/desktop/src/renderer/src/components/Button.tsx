import type { ComponentProps } from "react";
import { Spinner } from "./Spinner";

// primary: moss gradient lit from the top (specular edge + moss shadow live in shadow-moss); pressed = scale .98.
const variants = {
  primary:
    "relative bg-moss text-on-moss font-semibold shadow-moss hover:brightness-105 active:brightness-95 active:shadow-e1 disabled:bg-none disabled:bg-surface-4 disabled:text-ink-faint disabled:shadow-none",
  secondary: "relative bg-surface-3 text-ink font-medium shadow-e1 edge hover:bg-surface-4 active:bg-surface-3",
  danger: "relative bg-danger text-on-moss font-semibold shadow-e1 hover:brightness-105 active:brightness-95",
  ghost: "text-ink-muted hover:bg-surface-4 hover:text-ink",
  link: "text-moss-300 font-medium underline-offset-4 hover:underline",
};

type Props = ComponentProps<"button"> & { variant?: keyof typeof variants; loading?: boolean };

/** 44px tall (40px for the others), never wraps; `loading` disables it and shows a spinner beside the label. */
export function Button({ variant = "primary", loading = false, disabled, className = "", children, ...rest }: Props) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control px-4 transition-[background-color,filter,box-shadow,scale] duration-(--duration-fast) active:scale-98 disabled:cursor-not-allowed disabled:opacity-70 ${variant === "primary" ? "h-11" : "h-10"} ${variants[variant]} ${className}`}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}
