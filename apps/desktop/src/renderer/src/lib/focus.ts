import type { KeyboardEvent } from "react";

/** Up/Down (and Home/End) move focus between the `[data-nav-item]` elements of a list; Tab still leaves it. */
export function arrowNav(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const scope = e.currentTarget.closest("[popover]"); // a list does not walk into the menus nested in its rows
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-nav-item]:not([disabled])")].filter((i) => i.closest("[popover]") === scope);
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i === -1) return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
}
