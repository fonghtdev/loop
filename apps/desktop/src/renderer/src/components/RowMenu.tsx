import { DotsThree } from "@phosphor-icons/react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { arrowNav } from "../lib/focus";

/** One item of a popover menu. */
export function MenuItem({ icon, label, danger = false, onClick }: { icon: ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-nav-item
      onClick={onClick}
      className={`flex h-10 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm font-medium hover:bg-white/8 focus-visible:bg-cosmic-wash focus-visible:outline-offset-[-2px] focus-visible:shadow-none ${danger ? "text-danger" : "text-ink"}`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * A "..." button with a native popover menu under it (light dismiss, Esc), for rows of a list. `id` must be unique
 * and made of safe characters (ids from the server are); `children` get a `close` to call before acting.
 */
export function RowMenu({ id, label, className = "", children }: { id: string; label: string; className?: string; children: (close: () => void) => ReactNode }) {
  const menu = useRef<HTMLDivElement>(null);
  const anchor = { anchorName: `--a-${id}` } as CSSProperties;
  const placed = { positionAnchor: `--a-${id}` } as CSSProperties;
  return (
    <>
      <button
        type="button"
        popoverTarget={`menu-${id}`}
        aria-label={label}
        title={label}
        style={anchor}
        className={`grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink ${className}`}
      >
        <DotsThree aria-hidden="true" weight="bold" />
      </button>
      <div
        ref={menu}
        id={`menu-${id}`}
        popover="auto"
        style={placed}
        onToggle={(e) => (e as unknown as ToggleEvent).newState === "open" && menu.current?.querySelector<HTMLElement>("[data-nav-item]")?.focus()}
        onKeyDown={(e) => {
          e.stopPropagation();
          arrowNav(e);
        }}
        className="m-0 w-56 glass rounded-card p-1.5 text-ink [inset:auto] [position-try-fallbacks:flip-block] [right:anchor(right)] [top:calc(anchor(bottom)+4px)]"
      >
        {children(() => menu.current?.hidePopover())}
      </div>
    </>
  );
}
