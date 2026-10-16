import { MAX_GROUP_DM, MIN_GROUP_DM_INVITEES, type PresenceStatus } from "@loop/shared";
import type { QueryClient } from "@tanstack/react-query";
import type { Message } from "./chat";
import { normalize } from "./quick-switch";

export type PublicUser = { id: string; username: string; displayName?: string | null; avatarHash?: string | null };
export type Friend = PublicUser & { status: PresenceStatus };
export type FriendsData = { friends: Friend[]; incoming: PublicUser[]; outgoing: PublicUser[] };
/** A one-to-one DM: `kind` is absent from POST /dms and `dm:new` (older shape), "PAIR" in GET /dms. */
export type PairDm = { id: string; kind?: "PAIR"; user: Friend; lastMessageAt: string | null };
/** A group DM: every participant, the viewer included, oldest first. */
export type GroupDm = { id: string; kind: "GROUP"; name: string | null; ownerId: string | null; participants: Friend[]; lastMessageAt: string | null };
export type Dm = PairDm | GroupDm;

export const isGroup = (d: Dm): d is GroupDm => d.kind === "GROUP";
/** Everyone the DM shows (the other person of a pair; every participant of a group). */
export const dmPeople = (d: Dm): Friend[] => (isGroup(d) ? d.participants : [d.user]);
/** The pair DM with this person, if one is open (groups never count). */
export const pairWith = (dms: readonly Dm[] | undefined, userId: string) => dms?.find((d): d is PairDm => !isGroup(d) && d.user.id === userId);

export const FRIENDS_KEY = ["friends"] as const;
export const BLOCKS_KEY = ["blocks"] as const;
export const DMS_KEY = ["dms"] as const;

/** Server events on the user's own room (no subscribe needed) that change friends, DMs or presence. */
export type SocialEvent =
  | { type: "dm:message"; message: Message }
  | { type: "dm:new"; dm: { id: string; user: Friend } }
  /** `dm:new` of a group (we were added) and `dm:updated` (members or name changed): the whole group as we see it. */
  | { type: "dm:group"; dm: GroupDm }
  /** We left or were removed: the conversation is gone for us. */
  | { type: "dm:removed"; dmChannelId: string }
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

const withStatus = (u: Friend, userId: string, status: PresenceStatus) => (u.id === userId ? { ...u, status } : u);
export const setDmPresence = (dms: Dm[], userId: string, status: PresenceStatus): Dm[] =>
  dms.some((x) => dmPeople(x).some((u) => u.id === userId && u.status !== status))
    ? dms.map((x) => (isGroup(x) ? { ...x, participants: x.participants.map((u) => withStatus(u, userId, status)) } : { ...x, user: withStatus(x.user, userId, status) }))
    : dms;

const activity = (d: Dm) => (d.lastMessageAt ? Date.parse(d.lastMessageAt) : 0);
/** Newest activity first; a channel without messages keeps the server's place (it sorted by creation date). */
const byActivity = (dms: Dm[]) => [...dms].sort((a, b) => activity(b) - activity(a));

export const addDm = (dms: Dm[], dm: { id: string; user: Friend }): Dm[] =>
  dms.some((x) => x.id === dm.id) ? dms : [{ id: dm.id, user: dm.user, lastMessageAt: null }, ...dms];

/** A group we were added to, or its new state: replaces the cached copy (the server's copy is the whole truth), else goes first. */
export const upsertGroup = (dms: Dm[], g: GroupDm): Dm[] =>
  dms.some((x) => x.id === g.id) ? dms.map((x) => (x.id === g.id ? g : x)) : [g, ...dms];

export const removeDm = (dms: Dm[], id: string): Dm[] => (dms.some((x) => x.id === id) ? dms.filter((x) => x.id !== id) : dms);

/**
 * A group's title: its name, else the other participants' names joined ("A, B, C"; more than `shown` = "A, B, C +2"),
 * else `alone` (everyone else left).
 */
export function groupTitle(g: GroupDm, myId: string | undefined, nameOf: (id: string, username: string) => string, alone: string, shown = 3) {
  if (g.name) return g.name;
  const others = g.participants.filter((u) => u.id !== myId).map((u) => nameOf(u.id, u.username));
  if (!others.length) return alone;
  const head = others.slice(0, shown).join(", ");
  return others.length > shown ? `${head} +${others.length - shown}` : head;
}

/** What the viewer may do in a group (the server decides; this only hides buttons). */
export const groupRights = (g: GroupDm, myId: string | undefined) => {
  const owner = !!myId && g.ownerId === myId;
  return {
    owner,
    canAdd: g.participants.length < MAX_GROUP_DM,
    canRemove: (userId: string) => owner && userId !== myId && g.participants.some((u) => u.id === userId),
  };
};

/** The viewer's friends who could join the group: not in it yet and not blocked (the server checks again). */
export const addableFriends = (friends: readonly Friend[], g: GroupDm, blockedIds: ReadonlySet<string>) =>
  friends.filter((f) => !blockedIds.has(f.id) && !g.participants.some((u) => u.id === f.id));

/** Picking people for a new group: the creator plus up to MAX_GROUP_DM - 1 others; toggling past the cap does nothing. */
export const MAX_INVITEES = MAX_GROUP_DM - 1;
export const toggleInvitee = (selected: readonly string[], id: string, max = MAX_INVITEES): string[] =>
  selected.includes(id) ? selected.filter((x) => x !== id) : selected.length >= max ? [...selected] : [...selected, id];

/** Friends whose shown or login name matches the search (accents and case ignored, like Ctrl+K), by shown name. */
export function filterFriends(friends: readonly Friend[], query: string, nameOf: (id: string, username: string) => string) {
  const q = normalize(query);
  return friends
    .map((f) => ({ f, name: nameOf(f.id, f.username) }))
    .filter(({ f, name }) => !q || normalize(name).includes(q) || normalize(f.username).includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, "vi"))
    .map(({ f }) => f);
}
export const canCreateGroup = (selected: readonly string[]) => selected.length >= MIN_GROUP_DM_INVITEES && selected.length <= MAX_INVITEES;

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
    case "dm:group":
      return dms((d) => upsertGroup(d, e.dm));
    case "dm:removed":
      return dms((d) => removeDm(d, e.dmChannelId));
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
