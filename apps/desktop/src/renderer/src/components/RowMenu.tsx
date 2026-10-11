import { DotsThree } from "@phosphor-icons/react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { arrowNav } from "../lib/focus";
import { Tooltip } from "./Tooltip";

/** One item of a popover menu. */
export function MenuItem({ icon, label, danger = false, selected, onClick }: { icon: ReactNode; label: string; danger?: boolean; selected?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-nav-item
      aria-pressed={selected}
      onClick={onClick}
      className={`flex h-10 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm font-medium hover:bg-white/8 focus-visible:bg-cosmic-wash focus-visible:outline-offset-[-2px] focus-visible:shadow-none ${danger ? "text-danger" : "text-ink"}`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * A "..." button (or your own `trigger`, sized by `size`) with a native popover menu under it (light dismiss, Esc; it
 * flips above when there is no room below), for rows of a list. `id` must be unique and made of safe characters (ids
 * from the server are); `children` get a `close` to call before acting. `align="left"` opens it from the button's left
 * edge, `onOpen` runs when it opens.
 */
export function RowMenu({
  id,
  label,
  className = "",
  trigger = <DotsThree aria-hidden="true" weight="bold" />,
  size = "size-10",
  align = "right",
  width = "w-56",
  onOpen,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  trigger?: ReactNode;
  size?: string;
  align?: "left" | "right";
  width?: string;
  onOpen?: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const anchor = { anchorName: `--a-${id}` } as CSSProperties;
  const placed = { positionAnchor: `--a-${id}` } as CSSProperties;
  return (
    <>
      <Tooltip label={label}>
        <button
          type="button"
          popoverTarget={`menu-${id}`}
          aria-label={label}
          style={anchor}
          className={`grid ${size} shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink active:scale-[.98] ${className}`}
        >
          {trigger}
        </button>
      </Tooltip>
      <div
        ref={menu}
        id={`menu-${id}`}
        popover="auto"
        style={placed}
        onToggle={(e) => {
          if ((e as unknown as ToggleEvent).newState !== "open") return;
          onOpen?.();
          menu.current?.querySelector<HTMLElement>("[data-nav-item]")?.focus();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          arrowNav(e);
        }}
        className={`m-0 ${width} glass rounded-card p-1.5 text-ink [inset:auto] [position-try-fallbacks:flip-block] [top:calc(anchor(bottom)+4px)] ${align === "left" ? "[left:anchor(left)]" : "[right:anchor(right)]"}`}
      >
        {children(() => menu.current?.hidePopover())}
      </div>
    </>
  );
}
