import type { ComponentProps } from "react";
import { Spinner } from "./Spinner";

const variants = {
  primary: "bg-moss-400 text-on-moss font-semibold hover:bg-moss-300 active:bg-moss-500",
  ghost: "text-ink-muted hover:bg-surface-4 hover:text-ink",
  link: "text-moss-300 font-medium underline-offset-4 hover:underline",
};

type Props = ComponentProps<"button"> & { variant?: keyof typeof variants; loading?: boolean };

/** 44px tall (40px for ghost/link), never wraps; `loading` disables it and shows a spinner beside the label. */
export function Button({ variant = "primary", loading = false, disabled, className = "", children, ...rest }: Props) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control px-4 transition-colors duration-(--duration-fast) active:translate-y-px disabled:cursor-not-allowed disabled:opacity-70 ${variant === "primary" ? "h-11" : "h-10"} ${variants[variant]} ${className}`}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}
