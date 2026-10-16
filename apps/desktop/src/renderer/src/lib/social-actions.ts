import { presence, queryClient, session } from "./app";
import { profiles } from "./profiles";
import { useNav } from "./nav";
import {
  addDm,
  addFriend,
  addOutgoing,
  BLOCKS_KEY,
  DMS_KEY,
  FRIENDS_KEY,
  removeDm,
  removePerson,
  upsertGroup,
  type Dm,
  type Friend,
  type GroupDm,
  type FriendsData,
  type PublicUser,
} from "./social";

const api = session.client.request;
const friends = (fn: (d: FriendsData) => FriendsData) => queryClient.setQueryData<FriendsData>(FRIENDS_KEY, (d) => (d ? fn(d) : d));
const refetchFriends = () => void queryClient.invalidateQueries({ queryKey: FRIENDS_KEY });

// Each call throws the ApiError for the screen to show (errorMessage); the caches are touched only after success.

export async function sendFriendRequest(username: string) {
  const r = await api<{ status: "PENDING" | "ACCEPTED"; user: PublicUser }>("POST", "/friends/requests", { username });
  if (r.status === "ACCEPTED") {
    friends((d) => addFriend(d, r.user));
    refetchFriends();
  } else friends((d) => addOutgoing(d, r.user));
  return r;
}

export async function acceptRequest(user: PublicUser) {
  await api("POST", `/friends/requests/${user.id}/accept`);
  friends((d) => addFriend(d, user));
  refetchFriends();
}

/** Decline an incoming request or cancel an outgoing one: the same call. */
export async function dismissRequest(userId: string) {
  await api("DELETE", `/friends/requests/${userId}`);
  friends((d) => removePerson(d, userId));
}

export async function unfriend(userId: string) {
  await api("DELETE", `/friends/${userId}`);
  friends((d) => removePerson(d, userId));
}

export async function blockUser(user: PublicUser) {
  await api("PUT", `/blocks/${user.id}`);
  friends((d) => removePerson(d, user.id));
  queryClient.setQueryData<PublicUser[]>(BLOCKS_KEY, (b) => (b && !b.some((x) => x.id === user.id) ? [...b, user] : b));
}

/** Unblocking does not bring the friendship back (server rule). */
export async function unblockUser(userId: string) {
  await api("DELETE", `/blocks/${userId}`);
  queryClient.setQueryData<PublicUser[]>(BLOCKS_KEY, (b) => b?.filter((x) => x.id !== userId));
}

/** Get-or-create the DM with a friend and open it. */
export async function openDm(userId: string) {
  const dm = await api<{ id: string; user: Friend }>("POST", "/dms", { userId });
  queryClient.setQueryData<Dm[]>(DMS_KEY, (d) => (d ? addDm(d, dm) : d));
  useNav.setState({ guildId: null, channelId: null, dmId: dm.id, settings: null });
}

const dmCache = (fn: (d: Dm[]) => Dm[]) => queryClient.setQueryData<Dm[]>(DMS_KEY, (d) => (d ? fn(d) : d));
/** A group the server answered with: into the DM list, and its people into presence / profiles. */
function keepGroup(g: GroupDm) {
  presence.seed(g.participants, null);
  profiles.seed(g.participants, null);
  dmCache((d) => upsertGroup(d, g));
  return g;
}

/** New group with 2..9 friends (and an optional name); opens it. */
export async function createGroup(userIds: string[], name: string) {
  const g = keepGroup(await api<GroupDm>("POST", "/dms/group", { userIds, ...(name.trim() ? { name } : {}) }));
  useNav.setState({ guildId: null, channelId: null, dmId: g.id, settings: null });
  return g;
}

export const addToGroup = async (dmId: string, userId: string) => keepGroup(await api<GroupDm>("POST", `/dms/${dmId}/participants`, { userId }));
export const renameGroup = async (dmId: string, name: string) => keepGroup(await api<GroupDm>("PATCH", `/dms/${dmId}`, { name: name.trim() || null }));

/** Owner only (server checks): the updated group arrives as `dm:updated`. */
export const removeFromGroup = (dmId: string, userId: string) => api("DELETE", `/dms/${dmId}/participants/${userId}`);

/** Leave and go back to the friends screen; the list drops it now (the `dm:removed` echo is idempotent). */
export async function leaveGroup(dmId: string) {
  await api("DELETE", `/dms/${dmId}/participants/me`);
  dmCache((d) => removeDm(d, dmId));
  if (useNav.getState().dmId === dmId) useNav.setState({ dmId: null });
}
