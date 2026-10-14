/** Global shortcuts for the voice session: the accelerator syntax we accept, and how a key press becomes one. */
export type ShortcutAction = "mic" | "deafen";
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ["mic", "deafen"];

const MODIFIER = "CommandOrControl|Command|Control|Alt|Super";
const KEY = "[A-Z0-9]|F(?:[1-9]|1\\d|2[0-4])|Space|Up|Down|Left|Right";
const ACCELERATOR = new RegExp(`^((?:(?:${MODIFIER}|Shift)\\+)+)(${KEY})$`);

/**
 * Cautious on purpose: at least one modifier besides Shift (Shift+A is just typing), none twice, then one plain key.
 * Anything fancier (media keys, numpad, punctuation) is refused rather than passed to the OS.
 */
export function isAccelerator(v: unknown): v is string {
  const m = typeof v === "string" ? ACCELERATOR.exec(v) : null;
  if (!m) return false;
  const mods = m[1].slice(0, -1).split("+");
  return new Set(mods).size === mods.length && mods.some((x) => x !== "Shift");
}

type KeyLike = { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };
const NAMED: Record<string, string> = { Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };

/** A keydown in the "press the keys" box -> an accelerator, or null while it is not a valid one yet (only modifiers, odd key). */
export function acceleratorFromEvent(e: KeyLike, platform: string): string | null {
  const mods = [e.ctrlKey && "Control", e.metaKey && (platform === "darwin" ? "Command" : "Super"), e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d+$/.test(e.code) ? e.code : NAMED[e.code];
  const acc = [...mods, key].join("+");
  return key && isAccelerator(acc) ? acc : null;
}

const MAC_SYMBOL: Record<string, string> = { CommandOrControl: "⌘", Command: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" };
const OTHER_NAME: Record<string, string> = { CommandOrControl: "Ctrl", Control: "Ctrl", Super: "Win" };

/** How the keys read on this platform: ⌃⌥⇧⌘M on macOS, Ctrl+Shift+M elsewhere. */
export function formatAccelerator(acc: string, platform: string): string {
  const parts = acc.split("+");
  return platform === "darwin" ? parts.map((p) => MAC_SYMBOL[p] ?? p).join("") : parts.map((p) => OTHER_NAME[p] ?? p).join("+");
}
