import { create } from "zustand";
import type { SettingsTab } from "./admin";

/**
 * Where the user is: a server and its open channel, or (guildId null = Home) an open DM, or the Friends screen
 * (no DM open). `settings` = the open tab of the server's settings view (`settings:<guildId>`), only with a guild.
 */
export type Place = { guildId: string | null; channelId: string | null; dmId: string | null; settings: SettingsTab | null };
const HOME: Place = { guildId: null, channelId: null, dmId: null, settings: null };
const TABS: unknown[] = ["roles", "members", "overwrites", "danger"];
const key = (userId: string) => `loop.lastPlace.${userId}`;

export const useNav = create<Place>(() => HOME);

const idOrNull = (v: unknown) => (typeof v === "string" ? v : null);

/** A stored place back into shape; anything unexpected (old format, hand-edited) is Home. */
export function parsePlace(raw: string | null): Place {
  try {
    const v = JSON.parse(raw ?? "null");
    if (!v || typeof v !== "object") return HOME;
    const guildId = idOrNull(v.guildId);
    // one place at a time: a server has channels, Home has a DM
    // the restored settings tab is only a request: the view re-checks the user's rights (guardSettings) before showing it
    const settings = TABS.includes(v.settings) ? (v.settings as SettingsTab) : null;
    return guildId ? { guildId, channelId: idOrNull(v.channelId), dmId: null, settings } : { ...HOME, dmId: idOrNull(v.dmId) };
  } catch {
    return HOME;
  }
}

// localStorage holds this non-sensitive preference only (never tokens). Access can throw (disabled storage): ignore.
export function readLastPlace(userId: string): Place {
  try {
    return parsePlace(localStorage.getItem(key(userId)));
  } catch {
    return HOME;
  }
}

export function writeLastPlace(userId: string, place: Place) {
  try {
    localStorage.setItem(key(userId), JSON.stringify(place));
  } catch {
    // a lost preference is harmless
  }
}

export const goHome = () => useNav.setState(HOME);
