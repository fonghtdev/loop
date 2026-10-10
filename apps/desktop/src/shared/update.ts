/** The auto-update state machine's vocabulary, shared by main (sends), preload (validates) and the settings screen. */
export const UPDATE_STATES = ["disabled", "idle", "checking", "available", "downloading", "downloaded", "error"] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];
export type UpdateStatus = { state: UpdateState; version?: string; error?: string };

const MAX_ERROR = 200;
const MAX_VERSION = 64;

/** Updates run only in an installed app whose build baked an https feed URL (no URL = no network call at all). */
export function updatesEnabled({ isPackaged, feedUrl }: { isPackaged: boolean; feedUrl: string }): boolean {
  if (!isPackaged) return false;
  try {
    return new URL(feedUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/** A new check makes sense only when nothing is under way and nothing is waiting to be installed. */
export const canCheck = (state: UpdateState) => state === "idle" || state === "error";
export const canInstall = (state: UpdateState) => state === "downloaded";

/** Anything (a thrown value, an IPC payload) to a status the UI may show: known state, short plain strings. */
export function parseUpdateStatus(raw: unknown): UpdateStatus {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const state = UPDATE_STATES.find((s) => s === r.state) ?? "error";
  const out: UpdateStatus = { state };
  if (typeof r.version === "string") out.version = r.version.slice(0, MAX_VERSION);
  if (state === "error") out.error = (typeof r.error === "string" ? r.error : "").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR);
  return out;
}
