import type { ComponentProps, ReactNode } from "react";
import { Tooltip } from "./Tooltip";

/** A 40px icon-only button: `label` is its accessible name, `tip` the tooltip word (defaults to the label). */
export function IconButton({ icon, label, tip = label, danger = false, ...rest }: Omit<ComponentProps<"button">, "children" | "aria-label"> & { icon: ReactNode; label: string; tip?: string; danger?: boolean }) {
  return (
    <Tooltip label={tip}>
      <span className="inline-flex shrink-0">
        <button
          type="button"
          {...rest}
          aria-label={label}
          className={`grid size-10 place-items-center rounded-control enabled:hover:bg-surface-4 enabled:active:scale-[.98] disabled:opacity-40 ${danger ? "text-danger" : "text-ink-muted enabled:hover:text-ink"}`}
        >
          <span aria-hidden="true" className="flex">
            {icon}
          </span>
        </button>
      </span>
    </Tooltip>
  );
}
