import { Plus } from "@phosphor-icons/react";
import { Tooltip } from "./Tooltip";

/** A channel-list category title; the + (create a channel of this kind) exists only when `onAdd` is given. */
export function ChannelCategory({ label, addLabel, onAdd }: { label: string; addLabel: string; onAdd?: () => void }) {
  return (
    <li className="flex h-8 items-center justify-between pt-2 pr-1 pl-2 first:pt-0">
      <span className="text-micro font-bold tracking-[.08em] text-ink-faint uppercase">{label}</span>
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
    </li>
  );
}
