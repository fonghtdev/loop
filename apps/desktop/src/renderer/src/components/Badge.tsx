import { t } from "../i18n/t";
import { capped } from "../lib/unread";

/** A count bubble ("9+" capped). The number is decorative; the screen reader gets the full sentence, once, never live. */
export function Badge({ count, className = "", label = "unread.count" }: { count: number; className?: string; label?: "unread.count" | "unread.mentions" }) {
  return (
    <span className={`pointer-events-none grid h-5 min-w-5 shrink-0 place-items-center overflow-hidden rounded-full bg-danger px-1.5 text-xs leading-none font-bold text-on-moss shadow-e1 ${className}`}>
      <span key={count} aria-hidden="true" className="numeric animate-tick">
        {capped(count)}
      </span>
      <span className="sr-only">{t(label, { count: String(count) })}</span>
    </span>
  );
}

/** A dot for "something unread" with no number (channels). */
export function UnreadDot({ className = "" }: { className?: string }) {
  return (
    <span className={`grid size-2.5 shrink-0 place-items-center rounded-full bg-moss-300 ${className}`}>
      <span className="sr-only">{t("unread.some")}</span>
    </span>
  );
}
