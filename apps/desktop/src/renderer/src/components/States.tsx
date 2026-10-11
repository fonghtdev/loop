import { ArrowClockwise, WarningCircle } from "@phosphor-icons/react";
import type { CSSProperties, ReactNode } from "react";
import { t } from "../i18n/t";
import { Button } from "./Button";

/** The 48px bar on top of every column; plain text is truncated, anything else is laid out by the caller. */
export function ColumnHeader({ children }: { children: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-hair bg-head px-4 font-display text-[15px] font-bold shadow-[inset_0_1px_0_var(--color-highlight)]">
      {typeof children === "string" ? <span className="min-w-0 truncate">{children}</span> : children}
    </header>
  );
}

export function EmptyState({ icon, title, body }: { icon: ReactNode; title?: string; body: string }) {
  return (
    <div className="flex flex-col items-start gap-2 relative edge rounded-panel bg-raise p-4 shadow-e2">
      <span aria-hidden="true" className="grid size-9 place-items-center rounded-control bg-surface-3 text-moss-300">
        {icon}
      </span>
      {title && <p className="mt-1 text-sm font-semibold">{title}</p>}
      <p className="text-[13px] leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}

/** One loading block with the shared shimmer; size it with `className`. Decorative: announce loading in the container. */
export function SkeletonBlock({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden="true" style={style} className={`skeleton rounded-control ${className}`} />;
}

/** Placeholder rows while a list loads (announced once as "Đang tải"). */
export function Skeleton({ rows }: { rows: number }) {
  return (
    <div role="status" aria-label={t("common.loading")} className="flex flex-col gap-2 px-1">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonBlock key={i} className="h-8" style={{ width: `${85 - ((i * 17) % 35)}%` }} />
      ))}
    </div>
  );
}

/** A failed load with the reason and a retry button. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-panel bg-danger-bg p-4 text-sm leading-relaxed">
      <p className="flex items-start gap-2">
        <WarningCircle aria-hidden="true" className="mt-0.5 shrink-0 text-danger" />
        <span>{message}</span>
      </p>
      <Button variant="ghost" onClick={onRetry} className="text-ink">
        <ArrowClockwise aria-hidden="true" />
        {t("common.retry")}
      </Button>
    </div>
  );
}
