import type { DropTarget } from "../lib/categories";

/**
 * Classes of a row in the channel list during drag and drop. Only a manager gets the grab cursor (the same rows are not
 * draggable for anyone else). The indicator is an inset line / ring in the accent colour, static (nothing animates).
 */
export const dragClass = (draggable: boolean, drop?: DropTarget["position"], dragging?: boolean) =>
  [
    draggable && "cursor-grab [&_[data-nav-item]]:cursor-grab",
    dragging && "opacity-50",
    drop === "before" && "shadow-[inset_0_2px_0_var(--color-moss-400)]",
    drop === "after" && "shadow-[inset_0_-2px_0_var(--color-moss-400)]",
    drop === "inside" && "rounded-control ring-2 ring-moss-400 ring-inset",
  ]
    .filter(Boolean)
    .join(" ");
