import { CaretDown, Plus } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip";

/**
 * A category header: the title is the button that folds it (aria-expanded; the chevron turns). The + (a channel in this
 * category) and the menu exist only when the caller passes them, i.e. with MANAGE_CHANNELS.
 */
export function ChannelCategory({ name, collapsed, onToggle, addLabel, onAdd, menu }: { name: string; collapsed: boolean; onToggle: () => void; addLabel: string; onAdd?: () => void; menu?: ReactNode }) {
  return (
    <li className="group flex h-8 items-center pt-2 pr-1 first:pt-0">
      <Tooltip label={name}>
        <button
          type="button"
          data-nav-item
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-control pl-1 text-left text-micro font-bold tracking-[.08em] text-ink-faint uppercase hover:text-ink"
        >
          <CaretDown aria-hidden="true" weight="bold" className={`shrink-0 transition-transform duration-(--duration-fast) ${collapsed ? "-rotate-90" : ""}`} />
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </button>
      </Tooltip>
      {onAdd && (
        <Tooltip label={addLabel}>
          <button
            type="button"
            aria-label={addLabel}
            onClick={onAdd}
            className="grid size-8 place-items-center rounded-control text-ink-muted hover:bg-surface-3 hover:text-ink"
          >
            <Plus aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      {menu}
    </li>
  );
}
