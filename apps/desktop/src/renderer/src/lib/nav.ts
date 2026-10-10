import { create } from "zustand";

/** Where the user is: a server (null = home) and its open channel. */
export type Place = { guildId: string | null; channelId: string | null };
const HOME: Place = { guildId: null, channelId: null };
const key = (userId: string) => `loop.lastPlace.${userId}`;

export const useNav = create<Place>(() => HOME);

// localStorage holds this non-sensitive preference only (never tokens). Access can throw (disabled storage): ignore.
export function readLastPlace(userId: string): Place {
  try {
    const v = JSON.parse(localStorage.getItem(key(userId)) ?? "null");
    if (typeof v?.guildId !== "string") return HOME;
    return { guildId: v.guildId, channelId: typeof v.channelId === "string" ? v.channelId : null };
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
