import { useSyncExternalStore } from "react";

/** Voice-room sounds: on/off and volume 0-100. Per ACCOUNT on this machine (localStorage), like the density. */
export type SoundPrefs = { enabled: boolean; volume: number };
export const DEFAULT_SOUND_PREFS: SoundPrefs = { enabled: true, volume: 60 };

export const soundPrefsKey = (userId: string) => `loop.sounds.${userId}`;

/** Stored JSON -> valid prefs; each field falls back to its default on its own. */
export function parseSoundPrefs(raw: string | null | undefined): SoundPrefs {
  try {
    const v = JSON.parse(raw ?? "null");
    return {
      enabled: typeof v?.enabled === "boolean" ? v.enabled : DEFAULT_SOUND_PREFS.enabled,
      volume: typeof v?.volume === "number" && Number.isFinite(v.volume) ? Math.round(Math.min(100, Math.max(0, v.volume))) : DEFAULT_SOUND_PREFS.volume,
    };
  } catch {
    return DEFAULT_SOUND_PREFS;
  }
}

type Store = Pick<Storage, "getItem" | "setItem">;

export function createSoundPrefs(storage: () => Store | undefined) {
  let user: string | null = null;
  let current = DEFAULT_SOUND_PREFS;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((l) => l());
  return {
    get: () => current,
    /** The account whose preferences apply (null = signed out: defaults, nothing of the last account stays). */
    load(userId: string | null) {
      user = userId;
      try {
        current = userId ? parseSoundPrefs(storage()?.getItem(soundPrefsKey(userId))) : DEFAULT_SOUND_PREFS;
      } catch {
        current = DEFAULT_SOUND_PREFS;
      }
      publish();
    },
    set(patch: Partial<SoundPrefs>) {
      current = parseSoundPrefs(JSON.stringify({ ...current, ...patch }));
      try {
        if (user) storage()?.setItem(soundPrefsKey(user), JSON.stringify(current));
      } catch {
        // storage blocked or full: the choice still holds for this run
      }
      publish();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export const soundPrefs = createSoundPrefs(() => globalThis.window?.localStorage);

export const useSoundPrefs = () => useSyncExternalStore(soundPrefs.subscribe, soundPrefs.get);
