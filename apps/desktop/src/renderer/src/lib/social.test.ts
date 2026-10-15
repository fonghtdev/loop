import type { PresenceStatus } from "@loop/shared";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Message } from "./chat";
import {
  addDm,
  addFriend,
  addIncoming,
  addOutgoing,
  applySocialEvent,
  bumpDm,
  dmComposerState,
  DMS_KEY,
  FRIENDS_KEY,
  isOnline,
  removePerson,
  setDmPresence,
  setFriendPresence,
  showOnline,
  sortFriends,
  type Dm,
  type Friend,
  type FriendsData,
} from "./social";

const user = (id: string, status: PresenceStatus = "offline"): Friend => ({ id, username: id, status });
const data = (over: Partial<FriendsData> = {}): FriendsData => ({ friends: [], incoming: [], outgoing: [], ...over });
const dm = (id: string, other: string, lastMessageAt: string | null): Dm => ({ id, user: user(other), lastMessageAt });
const message = (dmChannelId: string, at: string): Message => ({
  id: `m-${at}`,
  channelId: null,
  dmChannelId,
  author: { id: "b", username: "b" },
  content: "hi",
  createdAt: at,
  editedAt: null,
  seq: "1",
  attachments: [],
});

describe("presence", () => {
  it("a blocked user is never online, whatever the flag says", () => {
    const blocked = new Set(["b"]);
    expect(showOnline("a", "online", blocked)).toBe(true);
    expect(showOnline("b", "online", blocked)).toBe(false);
    expect(showOnline("a", "offline", blocked)).toBe(false);
    expect(["online", "idle", "dnd", "offline"].map((s) => isOnline(s as PresenceStatus))).toEqual([true, true, true, false]);
  });
  it("sorts online friends first (blocked ones count as offline), then by name", () => {
    const list = [user("zed", "online"), user("ann"), user("bob", "idle"), user("cat", "dnd")];
    expect(sortFriends(list, new Set(["cat"])).map((f) => f.id)).toEqual(["bob", "zed", "ann", "cat"]);
  });
  it("presence updates friends and DM users in place, and returns the same object when nothing changes", () => {
    const d = data({ friends: [user("a"), user("b", "online")] });
    expect(setFriendPresence(d, "a", "idle").friends.map((f) => f.status)).toEqual(["idle", "online"]);
    expect(setFriendPresence(d, "a", "offline")).toBe(d);
    expect(setFriendPresence(d, "stranger", "online")).toBe(d);
    const dms = [dm("d1", "a", null)];
    expect(setDmPresence(dms, "a", "dnd")[0].user.status).toBe("dnd");
    expect(setDmPresence(dms, "a", "offline")).toBe(dms);
  });
});

describe("friend lists", () => {
  it("a request arrives once; one from a friend is ignored", () => {
    const d = addIncoming(data(), { id: "a", username: "a" });
    expect(addIncoming(d, { id: "a", username: "a" })).toBe(d);
    expect(addIncoming(data({ friends: [user("a")] }), { id: "a", username: "a" }).incoming).toEqual([]);
  });
  it("becoming friends settles the requests between the two", () => {
    const d = data({ incoming: [{ id: "a", username: "a" }], outgoing: [{ id: "a", username: "a" }, { id: "b", username: "b" }] });
    const next = addFriend(d, { id: "a", username: "a" });
    expect(next.friends.map((f) => f.id)).toEqual(["a"]);
    expect(next.incoming).toEqual([]);
    expect(next.outgoing.map((u) => u.id)).toEqual(["b"]);
    expect(addFriend(next, { id: "a", username: "a" }).friends).toHaveLength(1);
  });
  it("unfriend, decline, cancel and block take the person out of every list", () => {
    const d = data({ friends: [user("a")], incoming: [{ id: "b", username: "b" }], outgoing: [{ id: "c", username: "c" }] });
    expect(removePerson(removePerson(removePerson(d, "a"), "b"), "c")).toEqual(data());
  });
  it("addOutgoing is idempotent", () => {
    const d = addOutgoing(data(), { id: "a", username: "a" });
    expect(addOutgoing(d, { id: "a", username: "a" })).toBe(d);
  });
});

describe("DM list", () => {
  it("a new DM goes first, once", () => {
    const list = [dm("d1", "a", "2026-10-10T10:00:00Z")];
    const next = addDm(list, { id: "d2", user: user("b") });
    expect(next.map((x) => x.id)).toEqual(["d2", "d1"]);
    expect(addDm(next, { id: "d2", user: user("b") })).toBe(next);
  });
  it("a message moves its DM to the top by activity; an older one does not move it back", () => {
    const list = [dm("d1", "a", "2026-10-10T10:00:00Z"), dm("d2", "b", "2026-10-10T09:00:00Z")];
    const bumped = bumpDm(list, "d2", "2026-10-10T11:00:00Z")!;
    expect(bumped.map((x) => x.id)).toEqual(["d2", "d1"]);
    expect(bumpDm(bumped, "d2", "2026-10-10T08:00:00Z")!.find((x) => x.id === "d2")!.lastMessageAt).toBe("2026-10-10T11:00:00Z");
    expect(bumpDm(list, "unknown", "2026-10-10T11:00:00Z")).toBeNull();
  });
});

describe("applySocialEvent (TanStack caches, in place)", () => {
  function setup(friends = data(), dms: Dm[] = []) {
    const qc = new QueryClient();
    qc.setQueryData(FRIENDS_KEY, friends);
    qc.setQueryData(DMS_KEY, dms);
    return qc;
  }
  it("friend:request, friend:removed, presence, dm:new", () => {
    const qc = setup(data({ friends: [user("a")] }), [dm("d1", "a", null)]);
    applySocialEvent(qc, { type: "friend:request", from: { id: "r", username: "r" } });
    expect(qc.getQueryData<FriendsData>(FRIENDS_KEY)!.incoming.map((u) => u.id)).toEqual(["r"]);
    applySocialEvent(qc, { type: "presence", userId: "a", status: "idle" });
    expect(qc.getQueryData<FriendsData>(FRIENDS_KEY)!.friends[0].status).toBe("idle");
    expect(qc.getQueryData<Dm[]>(DMS_KEY)![0].user.status).toBe("idle");
    applySocialEvent(qc, { type: "dm:new", dm: { id: "d2", user: user("n") } });
    expect(qc.getQueryData<Dm[]>(DMS_KEY)!.map((x) => x.id)).toEqual(["d2", "d1"]);
    applySocialEvent(qc, { type: "friend:removed", userId: "a" });
    expect(qc.getQueryData<FriendsData>(FRIENDS_KEY)!.friends).toEqual([]);
  });
  it("friend:accepted adds the friend and settles the request", () => {
    const qc = setup(data({ outgoing: [{ id: "a", username: "a" }] }));
    applySocialEvent(qc, { type: "friend:accepted", user: { id: "a", username: "a" } });
    const d = qc.getQueryData<FriendsData>(FRIENDS_KEY)!;
    expect(d.friends.map((f) => f.id)).toEqual(["a"]);
    expect(d.outgoing).toEqual([]);
  });
  it("dm:message bumps a known DM; for an unknown one it asks for a refetch instead of guessing", () => {
    const qc = setup(data(), [dm("d1", "a", "2026-10-10T10:00:00Z"), dm("d2", "b", "2026-10-10T09:00:00Z")]);
    applySocialEvent(qc, { type: "dm:message", message: message("d2", "2026-10-10T12:00:00Z") });
    expect(qc.getQueryData<Dm[]>(DMS_KEY)!.map((x) => x.id)).toEqual(["d2", "d1"]);
    // the sender's own echo of the same message changes nothing more
    applySocialEvent(qc, { type: "dm:message", message: message("d2", "2026-10-10T12:00:00Z") });
    expect(qc.getQueryData<Dm[]>(DMS_KEY)!.map((x) => x.id)).toEqual(["d2", "d1"]);
    applySocialEvent(qc, { type: "dm:message", message: message("nope", "2026-10-10T13:00:00Z") });
    expect(qc.getQueryState(DMS_KEY)!.isInvalidated).toBe(true);
  });
  it("a cache that is not loaded yet is left alone", () => {
    const qc = new QueryClient();
    applySocialEvent(qc, { type: "friend:request", from: { id: "r", username: "r" } });
    applySocialEvent(qc, { type: "presence", userId: "a", status: "online" });
    expect(qc.getQueryData(FRIENDS_KEY)).toBeUndefined();
  });
});

describe("dmComposerState", () => {
  const base = { friends: data({ friends: [user("b")] }), friendsUpdatedAt: 100, blocked: new Set<string>(), otherId: "b", forbiddenAt: null };
  it("open for a friend", () => expect(dmComposerState(base)).toBe("ok"));
  it("loading until the friends list is known", () => expect(dmComposerState({ ...base, friends: undefined })).toBe("loading"));
  it("not a friend (unfriended): closed", () => expect(dmComposerState({ ...base, friends: data() })).toBe("notFriend"));
  it("blocked by me: closed, and says blocked", () => expect(dmComposerState({ ...base, blocked: new Set(["b"]), friends: data() })).toBe("blocked"));
  it("a 403 closes it even though the stale friends list still says friends (the other side blocked)", () => {
    expect(dmComposerState({ ...base, forbiddenAt: 150 })).toBe("refused");
  });
  it("once the friends list was refreshed after the 403 and says friends again, it opens", () => {
    expect(dmComposerState({ ...base, forbiddenAt: 90, friendsUpdatedAt: 100 })).toBe("ok");
  });
});
