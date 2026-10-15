import type { PresenceStatus } from "@loop/shared";
import type { QueryClient } from "@tanstack/react-query";
import type { Message } from "./chat";

export type PublicUser = { id: string; username: string };
export type Friend = PublicUser & { status: PresenceStatus };
export type FriendsData = { friends: Friend[]; incoming: PublicUser[]; outgoing: PublicUser[] };
export type Dm = { id: string; user: Friend; lastMessageAt: string | null };

export const FRIENDS_KEY = ["friends"] as const;
export const BLOCKS_KEY = ["blocks"] as const;
export const DMS_KEY = ["dms"] as const;

/** Server events on the user's own room (no subscribe needed) that change friends, DMs or presence. */
export type SocialEvent =
  | { type: "dm:message"; message: Message }
  | { type: "dm:new"; dm: { id: string; user: Friend } }
  | { type: "friend:request"; from: PublicUser }
  | { type: "friend:accepted"; user: PublicUser }
  | { type: "friend:removed"; userId: string }
  | { type: "presence"; userId: string; status: PresenceStatus };

const without = (list: PublicUser[], id: string) => list.filter((u) => u.id !== id);
const plain = ({ id, username }: PublicUser): PublicUser => ({ id, username });

/** Anything but offline counts as online (idle, do not disturb). */
export const isOnline = (status: PresenceStatus) => status !== "offline";

/** A blocked user never shows as online, whatever a stale list or an event says. */
export const showOnline = (userId: string, status: PresenceStatus, blockedIds: ReadonlySet<string>) => isOnline(status) && !blockedIds.has(userId);

export const addIncoming = (d: FriendsData, from: PublicUser): FriendsData =>
  d.incoming.some((u) => u.id === from.id) || d.friends.some((u) => u.id === from.id) ? d : { ...d, incoming: [...d.incoming, plain(from)] };

export const addOutgoing = (d: FriendsData, to: PublicUser): FriendsData =>
  d.outgoing.some((u) => u.id === to.id) ? d : { ...d, outgoing: [...d.outgoing, plain(to)] };

/** Becoming friends settles any request between the two; status is unknown until presence says (a refetch follows). */
export const addFriend = (d: FriendsData, user: PublicUser, status: PresenceStatus = "offline"): FriendsData => ({
  friends: d.friends.some((f) => f.id === user.id) ? d.friends : [...d.friends, { ...plain(user), status }],
  incoming: without(d.incoming, user.id),
  outgoing: without(d.outgoing, user.id),
});

/** Unfriended, declined, cancelled or blocked: the person leaves every list. */
export const removePerson = (d: FriendsData, userId: string): FriendsData => ({
  friends: d.friends.filter((f) => f.id !== userId),
  incoming: without(d.incoming, userId),
  outgoing: without(d.outgoing, userId),
});

export const setFriendPresence = (d: FriendsData, userId: string, status: PresenceStatus): FriendsData =>
  d.friends.some((f) => f.id === userId && f.status !== status) ? { ...d, friends: d.friends.map((f) => (f.id === userId ? { ...f, status } : f)) } : d;

export const setDmPresence = (dms: Dm[], userId: string, status: PresenceStatus): Dm[] =>
  dms.some((x) => x.user.id === userId && x.user.status !== status) ? dms.map((x) => (x.user.id === userId ? { ...x, user: { ...x.user, status } } : x)) : dms;

const activity = (d: Dm) => (d.lastMessageAt ? Date.parse(d.lastMessageAt) : 0);
/** Newest activity first; a channel without messages keeps the server's place (it sorted by creation date). */
const byActivity = (dms: Dm[]) => [...dms].sort((a, b) => activity(b) - activity(a));

export const addDm = (dms: Dm[], dm: { id: string; user: Friend }): Dm[] =>
  dms.some((x) => x.id === dm.id) ? dms : [{ id: dm.id, user: dm.user, lastMessageAt: null }, ...dms];

/** A message arrived in a DM: it moves up. null when the DM is not in the list (a refetch is needed). */
export function bumpDm(dms: Dm[], dmChannelId: string, at: string): Dm[] | null {
  const known = dms.some((x) => x.id === dmChannelId);
  return known ? byActivity(dms.map((x) => (x.id === dmChannelId && (!x.lastMessageAt || Date.parse(at) > Date.parse(x.lastMessageAt)) ? { ...x, lastMessageAt: at } : x))) : null;
}

/** Friends first online, then by name. */
export const sortFriends = (friends: Friend[], blockedIds: ReadonlySet<string>) =>
  [...friends].sort((a, b) => Number(showOnline(b.id, b.status, blockedIds)) - Number(showOnline(a.id, a.status, blockedIds)) || a.username.localeCompare(b.username, "vi"));

/** Applies one socket event to the TanStack caches, in place (a cache that is not loaded yet is left to its first fetch). */
export function applySocialEvent(qc: QueryClient, e: SocialEvent) {
  const friends = (fn: (d: FriendsData) => FriendsData) => qc.setQueryData<FriendsData>(FRIENDS_KEY, (d) => (d ? fn(d) : d));
  const dms = (fn: (d: Dm[]) => Dm[]) => qc.setQueryData<Dm[]>(DMS_KEY, (d) => (d ? fn(d) : d));
  switch (e.type) {
    case "friend:request":
      return friends((d) => addIncoming(d, e.from));
    case "friend:accepted":
      friends((d) => addFriend(d, e.user));
      return void qc.invalidateQueries({ queryKey: FRIENDS_KEY }); // the event does not say whether they are online
    case "friend:removed":
      return friends((d) => removePerson(d, e.userId));
    case "presence":
      friends((d) => setFriendPresence(d, e.userId, e.status));
      return dms((d) => setDmPresence(d, e.userId, e.status));
    case "dm:new":
      return dms((d) => addDm(d, e.dm));
    case "dm:message": {
      const id = e.message.dmChannelId;
      const bumped = id ? bumpDm(qc.getQueryData<Dm[]>(DMS_KEY) ?? [], id, e.message.createdAt) : null;
      if (bumped) dms(() => bumped);
      else void qc.invalidateQueries({ queryKey: DMS_KEY });
    }
  }
}

export type DmComposerState = "loading" | "ok" | "notFriend" | "blocked" | "refused";

/**
 * Whether a DM can be written to, from caches the UI already holds. History stays readable in every state.
 * "refused" = the server answered 403 and the friends list has not been refreshed since (it may still say friends,
 * e.g. when the other side blocked: a block sends no event to the blocked user).
 */
export function dmComposerState(a: {
  friends: FriendsData | undefined;
  friendsUpdatedAt: number;
  blocked: ReadonlySet<string>;
  otherId: string;
  forbiddenAt: number | null;
}): DmComposerState {
  if (!a.friends) return "loading";
  if (a.blocked.has(a.otherId)) return "blocked";
  if (!a.friends.friends.some((f) => f.id === a.otherId)) return "notFriend";
  return a.forbiddenAt !== null && a.forbiddenAt >= a.friendsUpdatedAt ? "refused" : "ok";
}
