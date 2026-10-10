import { queryClient, session } from "./app";
import { useNav } from "./nav";
import {
  addDm,
  addFriend,
  addOutgoing,
  BLOCKS_KEY,
  DMS_KEY,
  FRIENDS_KEY,
  removePerson,
  type Dm,
  type Friend,
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
