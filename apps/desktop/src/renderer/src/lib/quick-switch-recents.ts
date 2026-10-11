/**
 * The places the user went to (by the palette or by normal navigation), most recent first, per account.
 * A key names a place: `channel:<guild>:<channel>` (opening a server lands in a channel, so servers are remembered as one), `person:<user>` (a DM or a friend: the same
 * person whichever it is today), `place:home|friends|settings`. Stored as non-sensitive ids only.
 */
export const MAX_RECENTS = 8;
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY = new RegExp(`^(channel:${ID}:${ID}|person:${ID}|place:(home|friends|settings))$`);
const storageKey = (userId: string) => `loop.recents.${userId}`;

export const isRecentKey = (v: unknown): v is string => typeof v === "string" && KEY.test(v);

/** Stored text back into shape: anything unexpected is dropped, duplicates and the surplus too. */
export function parseRecents(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "null");
    return Array.isArray(v) ? pushRecent([], v.filter(isRecentKey).reverse()) : [];
  } catch {
    return [];
  }
}

/** `keys` (oldest first) pushed onto `list`: each goes to the front, once. */
export function pushRecent(list: string[], keys: string | string[]): string[] {
  let out = list;
  for (const k of Array.isArray(keys) ? keys : [keys]) out = [k, ...out.filter((x) => x !== k)].slice(0, MAX_RECENTS);
  return out;
}

export function readRecents(userId: string): string[] {
  try {
    return parseRecents(localStorage.getItem(storageKey(userId)));
  } catch {
    return [];
  }
}

export function recordRecent(userId: string, key: string) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(pushRecent(readRecents(userId), key)));
  } catch {
    // a lost preference is harmless
  }
}

type PlaceLike = { guildId: string | null; channelId: string | null; dmId: string | null; settings: string | null };
/** The key of where the user is, or null when it cannot be told (a DM not in the list yet, a server with no channel open). */
export function recentKeyOf(p: PlaceLike, dms: readonly { id: string; user: { id: string } }[] | undefined): string | null {
  if (p.settings === "user") return "place:settings";
  if (p.guildId) return p.channelId ? `channel:${p.guildId}:${p.channelId}` : null;
  if (p.dmId) {
    const dm = dms?.find((d) => d.id === p.dmId);
    return dm ? `person:${dm.user.id}` : null;
  }
  return "place:friends";
}
