import { t } from "../i18n/t";
import type { Searchable } from "./quick-switch";
import type { Channel, Guild } from "./permissions";
import type { Dm, Friend } from "./social";

/** Where choosing an item leads. Navigation itself lives with the UI (components/QuickSwitcher.tsx). */
export type Target =
  | { type: "guild"; guildId: string }
  | { type: "channel"; channel: Pick<Channel, "id" | "guildId" | "name" | "type"> }
  | { type: "dm"; dmId: string }
  | { type: "friend"; userId: string }
  | { type: "place"; place: "home" | "friends" | "settings" };

/**
 * One row of the palette. `key` is unique and doubles as the recents key (see quick-switch-recents.ts) except for servers;
 * `sub` is the second line; `convKey` is the unread-store key of a text channel or DM; `avatarId` gives a person/server its colour.
 */
export type Item = Searchable & { key: string; target: Target; sub: string; voice?: boolean; online?: boolean; convKey?: string; avatarId?: string };

export type Source = { guilds: Guild[]; channels: Record<string, Channel[] | undefined>; dms: Dm[]; friends: Friend[] };

/** Everything the user can jump to, from data the app already holds. A friend who already has a DM shows once, as the DM. */
export function buildItems({ guilds, channels, dms, friends }: Source): Item[] {
  const items: Item[] = [];
  for (const g of guilds) {
    items.push({ key: `guild:${g.id}`, kind: "server", name: g.name, sub: t("quick.server"), target: { type: "guild", guildId: g.id }, avatarId: g.id });
    for (const c of channels[g.id] ?? []) {
      const voice = c.type === "VOICE";
      items.push({
        key: `channel:${g.id}:${c.id}`,
        kind: "channel",
        name: c.name,
        scope: g.name,
        sub: voice ? t("quick.voiceIn", { server: g.name }) : g.name,
        target: { type: "channel", channel: c },
        voice,
        convKey: voice ? undefined : `channel:${c.id}`,
      });
    }
  }
  const person = (u: Friend, extra: Pick<Item, "kind" | "target" | "convKey">): Item => ({
    key: `person:${u.id}`,
    name: u.username,
    sub: t(extra.kind === "dm" ? "quick.dm" : "quick.friendNew"),
    avatarId: u.id,
    ...extra,
  });
  for (const d of dms) items.push(person(d.user, { kind: "dm", target: { type: "dm", dmId: d.id }, convKey: `dm:${d.id}` }));
  const withDm = new Set(dms.map((d) => d.user.id));
  for (const f of friends) if (!withDm.has(f.id)) items.push(person(f, { kind: "friend", target: { type: "friend", userId: f.id } }));
  const place = (p: "home" | "friends" | "settings", name: string): Item => ({ key: `place:${p}`, kind: "place", name, sub: t("quick.placeSub"), target: { type: "place", place: p } });
  items.push(place("home", t("quick.place.home")), place("friends", t("quick.place.friends")), place("settings", t("quick.place.settings")));
  return items;
}

/** Recent keys back to items; a key whose thing no longer exists (left server, deleted channel, removed friend) is dropped. */
export function resolveRecents(keys: readonly string[], items: readonly Item[]): Item[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  return keys.flatMap((k) => byKey.get(k) ?? []);
}
