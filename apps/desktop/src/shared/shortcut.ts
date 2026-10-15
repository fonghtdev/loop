/** Global shortcuts for the voice session: the accelerator syntax we accept, and how a key press becomes one. */
export type ShortcutAction = "mic" | "deafen";
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ["mic", "deafen"];

const MODIFIER = "CommandOrControl|Command|Control|Alt|Super";
// Names verified against Electron's globalShortcut.register. Not here on purpose: Escape / Backspace (they clear the binding), Tab (keeps keyboard focus movable), "+" (Electron throws; the key is "=" plus Shift).
const KEY = "[A-Z0-9]|F(?:[1-9]|1\\d|2[0-4])|Space|Up|Down|Left|Right|Enter|Home|End|PageUp|PageDown|Insert|Delete|[-=\\[\\];',./\\\\`]|num[0-9]|numadd|numsub|nummult|numdiv|numdec";
const ACCELERATOR = new RegExp(`^((?:(?:${MODIFIER}|Shift)\\+)*)(${KEY})$`);

/** Any single key, with or without modifiers (none twice). Only syntax: whether the OS lets us own it is found out when registering. */
export function isAccelerator(v: unknown): v is string {
  const m = typeof v === "string" ? ACCELERATOR.exec(v) : null;
  if (!m) return false;
  const mods = m[1] ? m[1].slice(0, -1).split("+") : [];
  return new Set(mods).size === mods.length;
}

/** True when no Ctrl/Cmd/Alt/Win is held: registering it takes that key from every other app (Shift alone still types the character). */
export function lacksRealModifier(acc: string): boolean {
  return !acc.split("+").slice(0, -1).some((p) => p !== "Shift");
}

type KeyLike = { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };
const NAMED: Record<string, string> = {
  Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Enter: "Enter", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
  NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult", NumpadDivide: "numdiv", NumpadDecimal: "numdec",
};

/** The physical key (`code`, so layout and Shift do not change it) -> Electron's name, or undefined for keys we do not bind. */
function keyName(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  return /^F\d+$/.test(code) ? code : NAMED[code];
}

/** A keydown in the "press the keys" box -> an accelerator, or null while it is not a valid one yet (only modifiers, unbindable key). */
export function acceleratorFromEvent(e: KeyLike, platform: string): string | null {
  const mods = [e.ctrlKey && "Control", e.metaKey && (platform === "darwin" ? "Command" : "Super"), e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  const key = keyName(e.code);
  const acc = [...mods, key].join("+");
  return key && isAccelerator(acc) ? acc : null;
}

const MAC_SYMBOL: Record<string, string> = { CommandOrControl: "⌘", Command: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" };
const OTHER_NAME: Record<string, string> = { CommandOrControl: "Ctrl", Control: "Ctrl", Super: "Win" };
const KEY_LABEL: Record<string, string> = { numadd: "Num +", numsub: "Num -", nummult: "Num *", numdiv: "Num /", numdec: "Num ." };

/** How the keys read on this platform: ⌃⌥⇧⌘M on macOS, Ctrl+Shift+M elsewhere. */
export function formatAccelerator(acc: string, platform: string): string {
  const parts = acc.split("+").map((p) => KEY_LABEL[p] ?? (/^num\d$/.test(p) ? `Num ${p[3]}` : p));
  return platform === "darwin" ? parts.map((p) => MAC_SYMBOL[p] ?? p).join("") : parts.map((p) => OTHER_NAME[p] ?? p).join("+");
}
