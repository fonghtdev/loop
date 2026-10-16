import type { UiohookKeyboardEvent } from "uiohook-napi";
import type { KeyHook } from "./ptt";

// UiohookKey names that differ from the Electron accelerator names the settings use (shared/shortcut.ts).
const ELECTRON_NAME: Record<string, string> = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
  NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult", NumpadDivide: "numdiv", NumpadDecimal: "numdec",
};

/**
 * The real system-wide keyboard hook (uiohook-napi, a native module), loaded on first use. null when it cannot load
 * (missing binary on this platform / architecture): push-to-talk then reports "unavailable" and the app carries on.
 * ponytail: modifier-only keys (right Ctrl as the talk key) and mouse buttons cannot be bound; the hook sees them, the settings capture does not.
 */
export function loadKeyHook(): KeyHook | null {
  try {
    const { uIOhook, UiohookKey } = require("uiohook-napi") as typeof import("uiohook-napi");
    const names = new Map<number, string>();
    for (const [name, code] of Object.entries(UiohookKey)) names.set(code, ELECTRON_NAME[name] ?? name.replace(/^Numpad(\d)$/, "num$1"));
    let listeners: [string, (e: UiohookKeyboardEvent) => void][] = [];
    return {
      start(onKey) {
        const listen = (type: "down" | "up") => (e: UiohookKeyboardEvent) => {
          const key = names.get(e.keycode);
          if (key) onKey({ type, key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
        };
        listeners = [["keydown", listen("down")], ["keyup", listen("up")]];
        for (const [event, fn] of listeners) uIOhook.on(event as "keydown", fn);
        uIOhook.start();
      },
      stop() {
        uIOhook.stop();
        for (const [event, fn] of listeners) uIOhook.removeListener(event, fn);
        listeners = [];
      },
    };
  } catch {
    return null;
  }
}
