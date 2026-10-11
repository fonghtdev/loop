/** Keyboard rules of the quick switcher. Pure: no DOM, so the IME and wrap rules are testable. */

type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; repeat?: boolean; isComposing?: boolean; keyCode?: number };

/** Cmd+K / Ctrl+K (not held down, not with Shift or Alt). */
export const isToggleShortcut = (e: KeyLike) => (!!e.metaKey || !!e.ctrlKey) && !e.shiftKey && !e.altKey && !e.repeat && e.key.toLowerCase() === "k";

/** One dialog at a time: the shortcut opens the palette only when no other dialog is open; it always closes it. */
export const shouldToggle = (paletteOpen: boolean, otherDialogOpen: boolean) => paletteOpen || !otherDialogOpen;

/** Telex/VNI composition (and Chromium's keyCode 229): the keys then belong to the IME, never to the list. */
export const isComposingKey = (e: KeyLike) => !!e.isComposing || e.keyCode === 229;

export type KeyAction = { type: "move"; to: number } | { type: "open" };
export const PAGE = 8;

/** What a key does to the list: arrows (and Ctrl+N / Ctrl+P) wrap, Home/End jump, PageUp/PageDown step by 8 and stop at the ends. */
export function listAction(e: KeyLike, active: number, count: number): KeyAction | null {
  if (isComposingKey(e) || count === 0) return null;
  const last = count - 1;
  const down = e.key === "ArrowDown" || (!!e.ctrlKey && e.key.toLowerCase() === "n");
  const up = e.key === "ArrowUp" || (!!e.ctrlKey && e.key.toLowerCase() === "p");
  if (down) return { type: "move", to: active >= last ? 0 : active + 1 };
  if (up) return { type: "move", to: active <= 0 ? last : active - 1 };
  if (e.key === "Home") return { type: "move", to: 0 };
  if (e.key === "End") return { type: "move", to: last };
  if (e.key === "PageDown") return { type: "move", to: Math.min(last, active + PAGE) };
  if (e.key === "PageUp") return { type: "move", to: Math.max(0, active - PAGE) };
  if (e.key === "Enter") return { type: "open" };
  return null;
}
