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

/** The dark sky a scene is set in (concentric: radius = the card's minus its padding). */
export function ArtFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div aria-hidden="true" className={`overflow-hidden rounded-control bg-[radial-gradient(90%_120%_at_20%_0,var(--color-cosmic-900),var(--color-surface-1))] [&>svg]:block [&>svg]:h-[96px] [&>svg]:w-full ${className}`}>
      {children}
    </div>
  );
}

/**
 * Nothing here yet: a cosmic scene (`art`, an Illustrations component, decorative), what it means, and what to do next
 * (`action`). `page` is the big centred version for a whole area; the default is a raised card for a column or list.
 */
export function EmptyState({ art, title, body, action, page = false }: { art: ReactNode; title: string; body: string; action?: ReactNode; page?: boolean }) {
  if (page)
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="flex max-w-[400px] flex-col items-center">
          <div aria-hidden="true" className="mb-3 [&>svg]:h-[150px] [&>svg]:w-[240px]">
            {art}
          </div>
          <p className="mb-2 font-display text-heading3 font-extrabold tracking-[-0.02em] text-balance break-words">{title}</p>
          <p className="text-ink-muted">{body}</p>
          {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
        </div>
      </div>
    );
  return (
    <div className="relative edge flex flex-col gap-1 rounded-panel bg-raise p-2 shadow-e2">
      <ArtFrame className="mb-2">{art}</ArtFrame>
      <p className="px-2 font-display text-title font-extrabold tracking-[-0.015em]">{title}</p>
      <p className="px-2 pb-2 text-small text-ink-muted">{body}</p>
      {action && <div className="flex flex-wrap gap-2 px-2 pb-2">{action}</div>}
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
