import { useSyncExternalStore } from "react";

/** How loud one other person's microphone is for ME (a slider 0-200% and a mute-for-me), per ACCOUNT on this machine (localStorage), like the sound prefs. */
export type UserVolume = { volume: number; muted: boolean };
export const DEFAULT_USER_VOLUME: UserVolume = { volume: 1, muted: false };
export const MAX_USER_VOLUME = 2;

export const voiceVolumeKey = (accountId: string) => `loop.voicevol.${accountId}`;

/** Only what differs from the default is kept (a small file, and people nobody touched cost nothing). */
type Stored = Record<string, Partial<UserVolume>>;

const clamp = (v: number) => Math.round(Math.min(MAX_USER_VOLUME, Math.max(0, v)) * 100) / 100;

/** One entry -> its non-default parts (empty = nothing worth keeping). */
function compact(v: unknown): Partial<UserVolume> {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const volume = typeof o.volume === "number" && Number.isFinite(o.volume) ? clamp(o.volume) : DEFAULT_USER_VOLUME.volume;
  return { ...(volume !== DEFAULT_USER_VOLUME.volume && { volume }), ...(o.muted === true && { muted: true }) };
}

/** Stored JSON -> the entries that are valid and not default; anything else (junk, an array, odd values) is dropped on its own. */
export function parseVoiceVolumes(raw: string | null | undefined): Stored {
  try {
    const v: unknown = JSON.parse(raw ?? "null");
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Stored = {};
    for (const [id, entry] of Object.entries(v)) {
      const kept = compact(entry);
      if (Object.keys(kept).length) out[id] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export const userVolumeOf = (all: Stored, userId: string): UserVolume => ({ ...DEFAULT_USER_VOLUME, ...all[userId] });

type Store = Pick<Storage, "getItem" | "setItem">;

export function createVoiceVolumes(storage: () => Store | undefined) {
  let user: string | null = null;
  let current: Stored = {};
  const listeners = new Set<() => void>();
  return {
    all: () => current,
    get: (userId: string) => userVolumeOf(current, userId),
    /** The account whose volumes apply (null = signed out: nothing of the last account stays). */
    load(accountId: string | null) {
      user = accountId;
      try {
        current = accountId ? parseVoiceVolumes(storage()?.getItem(voiceVolumeKey(accountId))) : {};
      } catch {
        current = {};
      }
      listeners.forEach((l) => l());
    },
    set(userId: string, patch: Partial<UserVolume>) {
      const { [userId]: _old, ...rest } = current;
      const kept = compact({ ...userVolumeOf(current, userId), ...patch });
      current = Object.keys(kept).length ? { ...rest, [userId]: kept } : rest;
      try {
        if (user) storage()?.setItem(voiceVolumeKey(user), JSON.stringify(current));
      } catch {
        // storage blocked or full: the choice still holds for this run
      }
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}
export type UserVolumes = Pick<ReturnType<typeof createVoiceVolumes>, "get" | "set">;

export const voiceVolumes = createVoiceVolumes(() => globalThis.window?.localStorage);

export function useUserVolume(userId: string): UserVolume {
  const all = useSyncExternalStore(voiceVolumes.subscribe, voiceVolumes.all);
  return userVolumeOf(all, userId);
}
