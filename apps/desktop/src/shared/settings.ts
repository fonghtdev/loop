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
};
export const DEFAULT_SETTINGS: Settings = { notifications: true, preview: true, closeToTray: true, startAtLogin: false };
const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whatever was stored (a corrupt file, an older version) back into a complete Settings: unknown keys dropped, bad types defaulted. */
export function parseSettings(raw: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (isRecord(raw)) for (const k of KEYS) if (typeof raw[k] === "boolean") out[k] = raw[k];
  return out;
}

/** A change asked for by the renderer: known keys with boolean values; unknown keys are dropped, a wrong type refuses the whole patch. */
export function parsePatch(raw: unknown): Partial<Settings> | null {
  if (!isRecord(raw)) return null;
  const patch: Partial<Settings> = {};
  for (const k of KEYS) {
    if (!Object.hasOwn(raw, k)) continue;
    if (typeof raw[k] !== "boolean") return null;
    patch[k] = raw[k];
  }
  return Object.keys(patch).length ? patch : null;
}
