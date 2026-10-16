import type { GuildUpdatedEvent, UserUpdatedEvent } from "@loop/shared";
import type { QueryClient } from "@tanstack/react-query";
import { createStore } from "zustand/vanilla";
import { API_URL } from "../../../shared/config";
import type { GuildData } from "./categories";
import type { Guild } from "./permissions";

/** What others show about a user. A field is absent until some payload told us (banner and status only come with the profile and `user:updated`). */
export type Profile = { displayName?: string | null; avatarHash?: string | null; bannerHash?: string | null; statusText?: string | null };
/** Anything the server sends about a user: the profile fields ride along when the payload has them. */
export type Known = { id: string; displayName?: unknown; avatarHash?: unknown; bannerHash?: unknown; statusText?: unknown };

const FIELDS = ["displayName", "avatarHash", "bannerHash", "statusText"] as const;
/** A string or null; anything else (a missing key, a wrong type) is "not told". */
const told = (v: unknown) => (typeof v === "string" || v === null ? v : undefined);

/** `old` with the told fields of `u` applied; the same object when nothing changed (so subscribers stay quiet). */
function merged(old: Profile | undefined, u: Known): Profile | undefined {
  const next: Profile = { ...old };
  let changed = false;
  for (const f of FIELDS) {
    const v = told(u[f]);
    if (v !== undefined && next[f] !== v) {
      next[f] = v;
      changed = true;
    }
  }
  return changed ? next : old;
}

/** userId -> profile, seeded from every list that carries users and kept live by `user:updated`. Session-scoped: `clear()` on sign-out. */
export function createProfiles() {
  const store = createStore<{ byId: Record<string, Profile> }>(() => ({ byId: {} }));
  const seedAll = (users: Known[]) => {
    const { byId } = store.getState();
    let next = byId;
    for (const u of users) {
      if (typeof u?.id !== "string") continue;
      const p = merged(next[u.id], u);
      if (p && p !== next[u.id]) next = { ...next, [u.id]: p };
    }
    if (next !== byId) store.setState({ byId: next });
  };
  return {
    store,
    /** Records the profile fields of a fetched list and hands the list back (so it can sit in a `.then`). */
    seed<T>(users: Known[], data: T): T {
      seedAll(users);
      return data;
    },
    /** A live change: all four fields are told, so a removed avatar (null) replaces the old hash. */
    apply: (e: Known) => seedAll([e]),
    clear: () => store.setState({ byId: {} }),
  };
}

/** The name to show: the display name when the user set one, else the username. */
export const displayNameOf = (byId: Readonly<Record<string, Profile>>, id: string, username: string) => byId[id]?.displayName || username;

/** The image URL of a user's avatar, cache-busted by its hash; null without a hash. The route answers 302 to the storage. */
export const avatarUrl = (id: string, hash: string | null | undefined) => (hash ? `${API_URL}/users/${id}/avatar?v=${hash}` : null);
export const bannerUrl = (id: string, hash: string | null | undefined) => (hash ? `${API_URL}/users/${id}/banner?v=${hash}` : null);
export const guildIconUrl = (id: string, hash: string | null | undefined) => (hash ? `${API_URL}/guilds/${id}/icon?v=${hash}` : null);

// ---- socket payloads: nothing is trusted, a malformed one is dropped ----
const str = (v: unknown): v is string => typeof v === "string" && v !== "";

export function parseUserUpdated(d: unknown): UserUpdatedEvent | null {
  const e = d as Partial<Record<keyof UserUpdatedEvent, unknown>> | null;
  if (!e || !str(e.id) || !str(e.username)) return null;
  const [displayName, avatarHash, bannerHash, statusText] = FIELDS.map((f) => told(e[f]));
  if ([displayName, avatarHash, bannerHash, statusText].includes(undefined)) return null;
  return { id: e.id, username: e.username, displayName, avatarHash, bannerHash, statusText } as UserUpdatedEvent;
}

export function parseGuildUpdated(d: unknown): GuildUpdatedEvent | null {
  const e = d as Partial<Record<keyof GuildUpdatedEvent, unknown>> | null;
  if (!e || !str(e.id) || !str(e.name) || told(e.iconHash) === undefined) return null;
  return { id: e.id, name: e.name, iconHash: e.iconHash as string | null };
}

/** `guild:updated` into the server list and the open guild's data, in place and idempotently (a cache not loaded yet is left to its first fetch). */
export function applyGuildUpdated(qc: QueryClient, e: GuildUpdatedEvent) {
  const patch = <G extends Guild>(g: G): G => (g.id === e.id && (g.name !== e.name || g.iconHash !== e.iconHash) ? { ...g, name: e.name, iconHash: e.iconHash } : g);
  qc.setQueryData<Guild[]>(["guilds"], (old) => old?.map(patch));
  qc.setQueryData<GuildData>(["guild", e.id], (old) => (old ? { ...old, guild: patch(old.guild) } : old));
}
