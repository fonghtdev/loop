import { create } from "zustand";
import type { SettingsTab } from "./admin";
import type { Channel } from "./permissions";
import type { VoiceTarget } from "./voice";
import { channelKey, dmKey, parseKey, type ConvKey } from "./conversation";

/**
 * Where the user is: a server and its open channel, or (guildId null = Home) an open DM, or the Friends screen
 * (no DM open). `settings` = the open tab of the server's settings view (only with a guild), or "user" = the user's own
 * settings view (any place). Every place change sets it back to null, so one field keeps the main area unambiguous.
 */
export type SettingsView = SettingsTab | "user";
export type Place = { guildId: string | null; channelId: string | null; dmId: string | null; settings: SettingsView | null };
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
    const user = v.settings === "user" ? "user" : null; // always valid for a signed-in user
    return guildId ? { guildId, channelId: idOrNull(v.channelId), dmId: null, settings: user ?? settings } : { ...HOME, dmId: idOrNull(v.dmId), settings: user };
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

/** The conversation on screen, if any (a settings view covers it). Voice channels are not conversations but share the key shape. */
export function openConversation(p: Place): ConvKey | null {
  if (p.settings) return null;
  if (p.guildId) return p.channelId ? channelKey(p.channelId) : null;
  return p.dmId ? dmKey(p.dmId) : null;
}

/** Where a clicked notification leads, re-checked against what we still know: only a DM that is still in the list. */
export function placeForKey(key: ConvKey, dmIds: readonly string[] | undefined): Place | null {
  const { kind, id } = parseKey(key);
  return kind === "dm" && dmIds?.includes(id) ? { ...HOME, dmId: id } : null;
}

/**
 * What choosing a channel does. A text channel is opened. A voice channel you are not in is only JOINED (the main
 * area stays where it is); one you are already in opens its room view.
 */
export const planOpen = (type: Channel["type"], connected: boolean) => ({ navigate: type !== "VOICE" || connected, join: type === "VOICE" && !connected });

/** The place of a connected voice channel's room view; null for a DM call or a target without a server. */
export const roomPlace = (t: VoiceTarget | null) => (t?.kind === "channel" && t.guildId ? { guildId: t.guildId, channelId: t.id, dmId: null, settings: null } : null);
