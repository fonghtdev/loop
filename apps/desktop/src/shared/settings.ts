import { isAccelerator } from "./shortcut";

/** Preferences the main process owns (they steer the tray, login item and notifications), kept in userData. */
export type Settings = {
  /** OS notifications for DMs and incoming calls. */
  notifications: boolean;
  /** Show the message text in a notification (off = only "new message" and the sender). */
  preview: boolean;
  /** Closing the window hides it (the app keeps running in the tray / dock). */
  closeToTray: boolean;
  /** Open when the user logs in (only in the installed app). */
  startAtLogin: boolean;
  /** Global shortcuts (work while the app has no focus); "" = none. */
  micShortcut: string;
  deafenShortcut: string;
  /** Push-to-talk: the mic only transmits while `pttKey` is held (a system-wide key hook, main/ptt.ts); false = voice activity. */
  pttMode: boolean;
  /** The push-to-talk key (an accelerator, a bare key is fine); "" = none, and push-to-talk then does nothing. */
  pttKey: string;
};
export const DEFAULT_SETTINGS: Settings = { notifications: true, preview: true, closeToTray: true, startAtLogin: false, micShortcut: "CommandOrControl+Shift+M", deafenShortcut: "CommandOrControl+Shift+D", pttMode: false, pttKey: "" };
const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
export type BooleanSetting = Exclude<keyof Settings, "micShortcut" | "deafenShortcut" | "pttKey">;

/** A boolean for the switches; for a shortcut or the push-to-talk key, "" (none) or a valid accelerator. */
const isValid = (k: keyof Settings, v: unknown) => (typeof DEFAULT_SETTINGS[k] === "boolean" ? typeof v === "boolean" : v === "" || isAccelerator(v));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whatever was stored (a corrupt file, an older version) back into a complete Settings: unknown keys dropped, bad types defaulted. */
export function parseSettings(raw: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (isRecord(raw)) for (const k of KEYS) if (isValid(k, raw[k])) Object.assign(out, { [k]: raw[k] });
  return out;
}

/** A change asked for by the renderer: known keys with a valid value (boolean, or "" / an accelerator for a shortcut); unknown keys are dropped, a wrong value refuses the whole patch. */
export function parsePatch(raw: unknown): Partial<Settings> | null {
  if (!isRecord(raw)) return null;
  const patch: Partial<Settings> = {};
  for (const k of KEYS) {
    if (!Object.hasOwn(raw, k)) continue;
    if (!isValid(k, raw[k])) return null;
    Object.assign(patch, { [k]: raw[k] });
  }
  return Object.keys(patch).length ? patch : null;
}
