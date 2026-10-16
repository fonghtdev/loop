import { describe, expect, it, vi } from "vitest";
import type { Message } from "./chat";
import { channelKey, dmKey } from "./conversation";
import { createRealtime, type SocketLike } from "./realtime";

type Handler = (...args: unknown[]) => void;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Just enough of a socket.io-client Socket, with "server" actions to drive it. */
class FakeSocket implements SocketLike {
  handlers = new Map<string, Handler[]>();
  emitted: { event: string; payload: unknown; ack?: Handler }[] = [];
  handshakes: unknown[] = [];
  active = false;
  connected = false;
  constructor(readonly opts: { auth: (cb: (data: unknown) => void) => void }) {}
  on(event: string, fn: (...args: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn as Handler]);
  }
  fire(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
  emit(event: string, payload?: unknown, ack?: Handler) {
    this.emitted.push({ event, payload, ack });
  }
  /** An attempt: like socket.io, asks the auth callback for the handshake data. */
  connect() {
    this.active = true;
    this.opts.auth((data) => this.handshakes.push(data));
  }
  disconnect() {
    this.active = false;
    this.connected = false;
  }
  removeAllListeners() {
    this.handlers.clear();
  }
  accept() {
    this.connected = true;
    this.fire("connect");
  }
  refuse(message = "Unauthorized") {
    this.active = false; // socket.io gives up after a middleware refusal
    this.fire("connect_error", new Error(message));
  }
  drop() {
    this.connected = false; // transport closed: socket.io keeps trying (active stays true)
    this.fire("disconnect", "transport close");
  }
  subscribes() {
    return this.emitted.filter((e) => e.event === "channel:subscribe");
  }
}

const msg = (channelId: string, id = "m1"): Message => ({
  id,
  channelId,
  dmChannelId: null,
  attachments: [],
  author: { id: "u", username: "u" },
  content: "hi",
  createdAt: "2026-10-10T00:00:00Z",
  editedAt: null,
  seq: "1",
});

/**
 * Models the auth client: `current` is the access token in memory; asking with the refused token refreshes to
 * the next one in `refreshes` (null = the refresh was rejected, signed out).
 */
function setup(first: string = "a1", refreshes: (string | null)[] = ["a2", "a3"]) {
  const sockets: FakeSocket[] = [];
  let current: string | null = first;
  const getToken = vi.fn(async (rejected?: string) => {
    if (rejected !== undefined && rejected === current) current = refreshes.shift() ?? null;
    return current;
  });
  const setCurrent = (t: string) => (current = t);
  const deps = {
    onEvent: vi.fn(),
    onActivity: vi.fn(),
    onMention: vi.fn(),
    onSubscribed: vi.fn(),
    onRefused: vi.fn(),
    onSocial: vi.fn(),
    onMyStatus: vi.fn(),
    onGuild: vi.fn(),
    onUserUpdated: vi.fn(),
    onGuildUpdated: vi.fn(),
    onWatched: vi.fn(),
    onWatchRefused: vi.fn(),
    onVoiceUpdate: vi.fn(),
    onCall: vi.fn(),
    onVoiceMoved: vi.fn(),
    onVoiceModerated: vi.fn(),
    onTyping: vi.fn(),
    onRead: vi.fn(),
    onThread: vi.fn(),
    onReconnected: vi.fn(),
  };
  const rt = createRealtime({
    url: "http://api",
    getToken,
    ...deps,
    retryDelayMs: 1,
    io: (_url, opts) => {
      const s = new FakeSocket(opts as never);
      sockets.push(s);
      return s;
    },
  });
  const status = () => rt.state.getState().status;
  return { rt, sockets, socket: () => sockets[sockets.length - 1], getToken, setCurrent, status, ...deps };
}

describe("socket lifecycle", () => {
  it("asks for the current token on every (re)connect attempt", async () => {
    const s = setup("a1");
    s.rt.start();
    await flush();
    expect(s.socket().handshakes).toEqual([{ token: "a1" }]);
    s.socket().accept();
    s.socket().drop();
    s.setCurrent("a2"); // a REST call refreshed meanwhile
    s.socket().connect(); // socket.io's own reconnection attempt
    await flush();
    expect(s.socket().handshakes).toEqual([{ token: "a1" }, { token: "a2" }]);
    expect(s.status()).toBe("reconnecting");
  });

  it("an Unauthorized handshake refreshes once (passing the refused token) and retries; refused again -> failed, no loop", async () => {
    const s = setup("stale", ["fresh"]);
    s.rt.start();
    await flush();
    s.socket().refuse();
    await flush();
    expect(s.getToken).toHaveBeenNthCalledWith(2, "stale"); // the single-flight refresh path
    expect(s.socket().handshakes).toEqual([{ token: "stale" }, { token: "fresh" }]);

    s.socket().refuse();
    await flush();
    expect(s.status()).toBe("failed");
    expect(s.getToken).toHaveBeenCalledTimes(3);
    expect(s.socket().handshakes).toHaveLength(2);
  });

  it("a successful connect resets the auth retry (an expiry hours later refreshes again)", async () => {
    const s = setup("t1", ["t2", "t3"]);
    s.rt.start();
    await flush();
    s.socket().refuse();
    await flush();
    s.socket().accept();
    s.socket().drop();
    s.socket().connect();
    await flush();
    s.socket().refuse();
    await flush();
    expect(s.socket().handshakes.at(-1)).toEqual({ token: "t3" });
    expect(s.status()).not.toBe("failed");
  });

  it("a rejected refresh (null token) stops the socket", async () => {
    const s = setup("stale", [null]);
    s.rt.start();
    await flush();
    s.socket().refuse();
    await flush();
    expect(s.status()).toBe("idle");
    expect(s.socket().active).toBe(false);
  });

  it("subscribes the open channel on connect and again after every reconnect, then catches up", async () => {
    const s = setup();
    s.rt.setConversation(channelKey("c1"));
    s.rt.start();
    await flush();
    s.socket().accept();
    expect(s.socket().subscribes().map((e) => e.payload)).toEqual([{ channelId: "c1" }]);
    s.socket().subscribes()[0].ack!({ ok: true });
    expect(s.onSubscribed).toHaveBeenCalledWith(channelKey("c1"));
    expect(s.onReconnected).not.toHaveBeenCalled();

    s.socket().drop();
    s.socket().accept();
    expect(s.onReconnected).toHaveBeenCalledTimes(1);
    expect(s.socket().subscribes()).toHaveLength(2);
    s.socket().subscribes()[1].ack!({ ok: true });
    expect(s.onSubscribed).toHaveBeenCalledTimes(2);
  });

  it("switching channels unsubscribes the old one; a late ack for it is ignored", async () => {
    const s = setup();
    s.rt.start();
    await flush();
    s.socket().accept();
    s.rt.setConversation(channelKey("c1"));
    s.rt.setConversation(channelKey("c2"));
    expect(s.socket().emitted.map((e) => `${e.event} ${(e.payload as { channelId: string }).channelId}`)).toEqual([
      "channel:subscribe c1",
      "channel:unsubscribe c1",
      "channel:subscribe c2",
    ]);
    s.socket().subscribes()[0].ack!({ ok: true });
    expect(s.onSubscribed).not.toHaveBeenCalled();
  });

  it("a refused subscription is reported", async () => {
    const s = setup();
    s.rt.setConversation(channelKey("c1"));
    s.rt.start();
    await flush();
    s.socket().accept();
    s.socket().subscribes()[0].ack!({ ok: false, error: "Not found" });
    expect(s.onRefused).toHaveBeenCalledWith(channelKey("c1"));
    expect(s.onSubscribed).not.toHaveBeenCalled();
  });

  it("passes events of the open channel only, and nothing after stop (sign-out)", async () => {
    const s = setup();
    s.rt.setConversation(channelKey("c1"));
    s.rt.start();
    await flush();
    const sock = s.socket();
    sock.accept();
    const ack = sock.subscribes()[0].ack!;
    sock.fire("message:new", msg("c2"));
    sock.fire("message:new", msg("c1"));
    sock.fire("message:delete", { id: "m1", channelId: "c1" });
    expect(s.onEvent.mock.calls.map((c) => [c[0], c[1].type])).toEqual([
      [channelKey("c1"), "message:new"],
      [channelKey("c1"), "message:delete"],
    ]);

    // handlers captured before stop: a late event or ack must still be ignored
    const late = [...(sock.handlers.get("message:new") ?? [])];
    s.rt.stop();
    late.forEach((fn) => fn(msg("c1", "m2")));
    ack({ ok: true });
    expect(s.onEvent).toHaveBeenCalledTimes(2);
    expect(s.onSubscribed).not.toHaveBeenCalled();
    expect(s.status()).toBe("idle");
    expect(sock.active).toBe(false);
  });

  it("a server-side disconnect (no auto-reconnect in socket.io) is retried here", async () => {
    const s = setup();
    s.rt.start();
    await flush();
    s.socket().accept();
    s.socket().active = false; // "io server disconnect"
    s.socket().fire("disconnect", "io server disconnect");
    await new Promise((r) => setTimeout(r, 10));
    expect(s.socket().handshakes).toHaveLength(2);
  });
});

describe("DM, friend and presence events", () => {
  const dmMsg = (dmChannelId: string, id = "m1"): Message => ({ ...msg("x", id), channelId: null, dmChannelId });
  async function connected(open?: Parameters<ReturnType<typeof setup>["rt"]["setConversation"]>[0]) {
    const s = setup();
    if (open) s.rt.setConversation(open);
    s.rt.start();
    await flush();
    s.socket().accept();
    return s;
  }

  it("the open DM gets message events (never a subscribe); other DMs only update the list", async () => {
    const s = await connected(dmKey("d1"));
    const sock = s.socket();
    expect(sock.emitted).toEqual([]); // every socket is already in the user's own room
    sock.fire("dm:message:new", dmMsg("d1", "m1"));
    sock.fire("dm:message:new", dmMsg("d2", "m2"));
    sock.fire("dm:message:update", dmMsg("d1", "m1"));
    sock.fire("dm:message:update", dmMsg("d2", "m2"));
    sock.fire("dm:message:delete", { id: "m1", dmChannelId: "d1" });
    sock.fire("dm:message:delete", { id: "m2", dmChannelId: "d2" });
    expect(s.onEvent.mock.calls.map((c) => [c[0], c[1].type])).toEqual([
      [dmKey("d1"), "message:new"],
      [dmKey("d1"), "message:update"],
      [dmKey("d1"), "message:delete"],
    ]);
    // both new messages bump the DM list, the open one included
    expect(s.onSocial.mock.calls.map((c) => [c[0].type, c[0].message.dmChannelId])).toEqual([
      ["dm:message", "d1"],
      ["dm:message", "d2"],
    ]);
  });

  it("a DM and a channel with the same id are not mixed up", async () => {
    const s = await connected(channelKey("same"));
    s.socket().fire("dm:message:new", dmMsg("same"));
    expect(s.onEvent).not.toHaveBeenCalled();
    const t = await connected(dmKey("same"));
    t.socket().fire("message:new", msg("same"));
    expect(t.onEvent).not.toHaveBeenCalled();
  });

  it("opening a DM listens at once, and again after every reconnect (that is the catch-up trigger)", async () => {
    const s = await connected();
    s.rt.setConversation(dmKey("d1"));
    expect(s.onSubscribed).toHaveBeenCalledWith(dmKey("d1"));
    s.socket().drop();
    s.socket().accept();
    expect(s.onReconnected).toHaveBeenCalledTimes(1);
    expect(s.onSubscribed).toHaveBeenCalledTimes(2);
    expect(s.socket().emitted).toEqual([]);
  });

  it("leaving a DM sends no unsubscribe; leaving a channel does", async () => {
    const s = await connected(dmKey("d1"));
    s.rt.setConversation(channelKey("c1"));
    s.rt.setConversation(dmKey("d2"));
    expect(s.socket().emitted.map((e) => e.event)).toEqual(["channel:subscribe", "channel:unsubscribe"]);
  });

  it("friend and presence events reach onSocial whatever is open", async () => {
    const s = await connected();
    const sock = s.socket();
    sock.fire("dm:new", { id: "d9", user: { id: "u", username: "u", status: "idle" } });
    sock.fire("friend:request", { from: { id: "u", username: "u" } });
    sock.fire("friend:accepted", { user: { id: "u", username: "u" } });
    sock.fire("friend:removed", { userId: "u" });
    sock.fire("presence:update", { userId: "u", online: true, status: "dnd" });
    sock.fire("presence:update", { userId: "u", online: false, status: "offline" });
    sock.fire("presence:update", { userId: "u", online: true, status: "bogus" });
    expect(s.onSocial.mock.calls.map((c) => c[0])).toEqual([
      { type: "dm:new", dm: { id: "d9", user: { id: "u", username: "u", status: "idle" } } },
      { type: "friend:request", from: { id: "u", username: "u" } },
      { type: "friend:accepted", user: { id: "u", username: "u" } },
      { type: "friend:removed", userId: "u" },
      { type: "presence", userId: "u", status: "dnd" },
      { type: "presence", userId: "u", status: "offline" },
      { type: "presence", userId: "u", status: "offline" }, // an unknown status reads as offline
    ]);
  });

  it("me:status reaches onMyStatus only with a valid choice", async () => {
    const s = await connected();
    s.socket().fire("me:status", { status: "dnd" });
    s.socket().fire("me:status", { status: "offline" }); // an effective status, not a choice
    s.socket().fire("me:status", {});
    expect(s.onMyStatus.mock.calls).toEqual([["dnd"]]);
  });

  it("the away flag is sent on change, skipped when unchanged, and re-sent after every reconnect", async () => {
    const s = await connected();
    const sock = s.socket();
    const away = () => sock.emitted.filter((e) => e.event === "presence:away").map((e) => e.payload);
    s.rt.setAway(true);
    s.rt.setAway(true);
    expect(away()).toEqual([{ away: true }]);
    sock.drop();
    s.rt.setAway(false);
    s.rt.setAway(true); // changed while offline: nothing can be sent now
    expect(away()).toEqual([{ away: true }]);
    sock.accept();
    expect(away()).toEqual([{ away: true }, { away: true }]);
  });

  it("an active user sends no away flag on connect (the server starts at false)", async () => {
    const s = await connected();
    expect(s.socket().emitted.filter((e) => e.event === "presence:away")).toEqual([]);
  });

  it("channel and category events reach onGuild whatever is open; malformed ones and ones after stop do not", async () => {
    const s = await connected();
    const sock = s.socket();
    const category = { id: "k", guildId: "g", name: "n", position: 0, createdAt: "t" };
    const gone = { guildId: "g", categoryId: "k", channels: [] };
    const layout = { guildId: "g", categories: [], channels: [] };
    sock.fire("channel:created", { id: "c", guildId: "g" });
    sock.fire("category:created", category);
    sock.fire("category:updated", category);
    sock.fire("category:deleted", gone);
    sock.fire("layout:updated", layout);
    for (const [event, payload] of [["channel:created", null], ["category:created", {}], ["category:deleted", { categoryId: "k" }], ["layout:updated", { guildId: "g" }]] as const) sock.fire(event, payload);
    expect(s.onGuild.mock.calls.map((c) => c[0].type)).toEqual(["channel:created", "category:created", "category:updated", "category:deleted", "layout:updated"]);
    const late = [...(sock.handlers.get("layout:updated") ?? [])];
    s.rt.stop();
    late.forEach((fn) => fn(layout));
    expect(s.onGuild).toHaveBeenCalledTimes(5);
  });

  it("roles:updated reaches onGuild; a payload without a guild id does not", async () => {
    const s = await connected();
    s.socket().fire("roles:updated", { guildId: "g" });
    s.socket().fire("roles:updated", {});
    expect(s.onGuild.mock.calls.map((c) => c[0])).toEqual([{ type: "roles:updated", guildId: "g" }]);
  });

  it("channel:updated reaches onGuild like channel:created", async () => {
    const s = await connected();
    s.socket().fire("channel:updated", { id: "c", guildId: "g", topic: "x" });
    s.socket().fire("channel:updated", null);
    expect(s.onGuild.mock.calls.map((c) => c[0].type)).toEqual(["channel:updated"]);
  });

  it("user:updated and guild:updated are validated; malformed ones and ones after stop are dropped", async () => {
    const s = await connected();
    const sock = s.socket();
    const user = { id: "u", username: "an", displayName: "Anh", avatarHash: null, bannerHash: null, statusText: "bận" };
    sock.fire("user:updated", user);
    sock.fire("user:updated", { ...user, avatarHash: 5 });
    sock.fire("user:updated", { id: "u" });
    sock.fire("user:updated", null);
    expect(s.onUserUpdated.mock.calls).toEqual([[user]]);
    sock.fire("guild:updated", { id: "g", name: "Nhóm", iconHash: "abc" });
    sock.fire("guild:updated", { id: "g", name: "Nhóm" });
    sock.fire("guild:updated", { id: "g", name: 7, iconHash: null });
    expect(s.onGuildUpdated.mock.calls).toEqual([[{ id: "g", name: "Nhóm", iconHash: "abc" }]]);
    const late = [...(sock.handlers.get("user:updated") ?? [])];
    s.rt.stop();
    late.forEach((fn) => fn(user));
    expect(s.onUserUpdated).toHaveBeenCalledTimes(1);
  });

  it("group DM events: dm:new of a group and dm:updated become dm:group, dm:removed passes the id; malformed ones are dropped", async () => {
    const s = await connected();
    const sock = s.socket();
    const g = { id: "g1", kind: "GROUP", name: null, ownerId: "u", participants: [{ id: "u", username: "u", status: "online" }], lastMessageAt: null };
    sock.fire("dm:new", g);
    sock.fire("dm:updated", { ...g, name: "Crew" });
    sock.fire("dm:removed", { dmChannelId: "g1" });
    for (const bad of [null, { id: "g1" }, { ...g, participants: "x" }, { ...g, kind: "PAIR" }]) sock.fire("dm:updated", bad);
    sock.fire("dm:removed", {});
    expect(s.onSocial.mock.calls.map((c) => c[0])).toEqual([
      { type: "dm:group", dm: g },
      { type: "dm:group", dm: { ...g, name: "Crew" } },
      { type: "dm:removed", dmChannelId: "g1" },
    ]);
  });

  it("malformed payloads are dropped", async () => {
    const s = await connected();
    for (const [event, payload] of [["friend:request", null], ["friend:removed", {}], ["presence:update", undefined], ["dm:new", { id: "x" }], ["dm:message:new", null]] as const)
      s.socket().fire(event, payload);
    expect(s.onSocial).not.toHaveBeenCalled();
    expect(s.onEvent).not.toHaveBeenCalled();
  });

  it("nothing is processed after stop (sign-out), even by handlers captured earlier", async () => {
    const s = await connected(dmKey("d1"));
    const sock = s.socket();
    const handlers = ["dm:message:new", "dm:new", "friend:request", "friend:accepted", "friend:removed", "presence:update", "me:status"].map((e) => [e, [...(sock.handlers.get(e) ?? [])]] as const);
    s.rt.stop();
    for (const [event, fns] of handlers) fns.forEach((fn) => fn(event === "dm:message:new" ? dmMsg("d1") : { from: { id: "u" }, user: { id: "u" }, userId: "u", id: "d", status: "dnd" }));
    expect(s.onSocial).not.toHaveBeenCalled();
    expect(s.onMyStatus).not.toHaveBeenCalled();
    expect(s.onEvent).not.toHaveBeenCalled();
  });
});

describe("watched voice channels", () => {
  async function connected() {
    const s = setup();
    s.rt.start();
    await flush();
    s.socket().accept();
    return s;
  }
  const subs = (sock: FakeSocket) => sock.subscribes().map((e) => (e.payload as { channelId: string }).channelId);
  const ackAll = (sock: FakeSocket, ok = true) => sock.subscribes().forEach((e) => e.ack?.({ ok }));

  it("subscribes to every watched channel, drops the ones removed, and fetches after each ack", async () => {
    const s = await connected();
    s.rt.setWatched(["v1", "v2"]);
    expect(subs(s.socket())).toEqual(["v1", "v2"]);
    ackAll(s.socket());
    expect(s.onWatched.mock.calls.map((c) => c[0])).toEqual(["v1", "v2"]);
    s.rt.setWatched(["v2", "v3"]);
    expect(s.socket().emitted.filter((e) => e.event === "channel:unsubscribe").map((e) => e.payload)).toEqual([{ channelId: "v1" }]);
    expect(subs(s.socket())).toEqual(["v1", "v2", "v3"]); // only v3 is new
  });

  it("resubscribes the whole set after a reconnect and fetches again", async () => {
    const s = await connected();
    s.rt.setWatched(["v1", "v2"]);
    ackAll(s.socket());
    s.socket().drop();
    const before = s.socket().subscribes().length;
    s.socket().accept();
    expect(subs(s.socket()).slice(before)).toEqual(["v1", "v2"]);
    s.socket().subscribes().slice(before).forEach((e) => e.ack?.({ ok: true }));
    expect(s.onWatched).toHaveBeenCalledTimes(4);
  });

  it("set before the socket is up: subscribed on connect", async () => {
    const s = setup();
    s.rt.setWatched(["v1"]);
    s.rt.start();
    await flush();
    expect(s.socket().subscribes()).toHaveLength(0);
    s.socket().accept();
    expect(subs(s.socket())).toEqual(["v1"]);
  });

  it("a refused channel is reported and dropped from the set (not resubscribed on reconnect)", async () => {
    const s = await connected();
    s.rt.setWatched(["v1", "v2"]);
    s.socket().subscribes()[0].ack?.({ ok: false });
    s.socket().subscribes()[1].ack?.({ ok: true });
    expect(s.onWatchRefused).toHaveBeenCalledWith("v1");
    const before = s.socket().subscribes().length;
    s.socket().drop();
    s.socket().accept();
    expect(subs(s.socket()).slice(before)).toEqual(["v2"]);
  });

  it("voice:update is delivered only for watched channels", async () => {
    const s = await connected();
    s.rt.setWatched(["v1"]);
    s.socket().fire("voice:update", { channelId: "v1", participants: [{ userId: "u", username: "u" }] });
    s.socket().fire("voice:update", { channelId: "other", participants: [] });
    s.socket().fire("voice:update", { channelId: "v1", participants: "nope" });
    expect(s.onVoiceUpdate.mock.calls).toEqual([["v1", [{ userId: "u", username: "u" }]]]);
  });

  it("stop (sign-out) clears the set: nothing delivered, nothing resubscribed", async () => {
    const s = await connected();
    s.rt.setWatched(["v1"]);
    const sock = s.socket();
    const handlers = [...(sock.handlers.get("voice:update") ?? [])];
    s.rt.stop();
    handlers.forEach((fn) => fn({ channelId: "v1", participants: [] }));
    expect(s.onVoiceUpdate).not.toHaveBeenCalled();
    s.rt.start();
    await flush();
    s.socket().accept();
    expect(s.socket().subscribes()).toHaveLength(0);
  });

  it("voice:moved is forwarded with who moved us, malformed ones are dropped, none after stop", async () => {
    const s = await connected();
    const sock = s.socket();
    sock.fire("voice:moved", { channelId: "v2", by: { id: "u", username: "mod" } });
    sock.fire("voice:moved", { channelId: 7, by: { username: "mod" } });
    sock.fire("voice:moved", { channelId: "v3" });
    sock.fire("voice:moved", null);
    expect(s.onVoiceMoved.mock.calls).toEqual([[{ channelId: "v2", byName: "mod" }]]);
    const handlers = [...(sock.handlers.get("voice:moved") ?? [])];
    s.rt.stop();
    handlers.forEach((fn) => fn({ channelId: "v4", by: { username: "mod" } }));
    expect(s.onVoiceMoved).toHaveBeenCalledTimes(1);
  });

  it("voice:moderated is forwarded with the state and who did it, malformed ones are dropped", async () => {
    const s = await connected();
    const sock = s.socket();
    sock.fire("voice:moderated", { channelId: "v1", serverMute: true, serverDeafen: false, by: { id: "u", username: "mod" } });
    sock.fire("voice:moderated", { channelId: "v1", serverMute: "yes", serverDeafen: false, by: { username: "mod" } });
    sock.fire("voice:moderated", { channelId: "v1", serverMute: true, serverDeafen: false });
    sock.fire("voice:moderated", null);
    expect(s.onVoiceModerated.mock.calls).toEqual([[{ channelId: "v1", serverMute: true, serverDeafen: false, byName: "mod" }]]);
  });

  it("typing and read:updated are forwarded as conversation keys, malformed ones dropped, none after stop", async () => {
    const s = await connected();
    const sock = s.socket();
    sock.fire("typing", { channelId: "c1", userId: "u1", at: 1 });
    sock.fire("typing", { dmChannelId: "d1", userId: "u2", at: 1 });
    sock.fire("typing", { channelId: "c1" });
    sock.fire("typing", { userId: "u3" });
    sock.fire("typing", null);
    expect(s.onTyping.mock.calls).toEqual([[channelKey("c1"), "u1"], [dmKey("d1"), "u2"]]);
    sock.fire("read:updated", { channelId: "c1", lastReadSeq: "42" });
    sock.fire("read:updated", { dmChannelId: "d1", lastReadSeq: "7" });
    sock.fire("read:updated", { channelId: "c1", lastReadSeq: "-1" });
    sock.fire("read:updated", { channelId: "c1", lastReadSeq: 5 });
    sock.fire("read:updated", { lastReadSeq: "5" });
    expect(s.onRead.mock.calls).toEqual([[channelKey("c1"), "42"], [dmKey("d1"), "7"]]);
    const handlers = [...(sock.handlers.get("typing") ?? [])];
    s.rt.stop();
    handlers.forEach((fn) => fn({ channelId: "c1", userId: "u1" }));
    expect(s.onTyping).toHaveBeenCalledTimes(2);
  });

  it("sendTyping emits the right payload per kind, and nothing while offline", async () => {
    const s = await connected();
    const sock = s.socket();
    s.rt.sendTyping(channelKey("c1"));
    s.rt.sendTyping(dmKey("d1"));
    expect(sock.emitted.filter((e) => e.event === "typing").map((e) => e.payload)).toEqual([{ channelId: "c1" }, { dmChannelId: "d1" }]);
    sock.drop();
    s.rt.sendTyping(channelKey("c1"));
    expect(sock.emitted.filter((e) => e.event === "typing")).toHaveLength(2);
  });

  it("call events are forwarded, malformed ones dropped, none after stop", async () => {
    const s = await connected();
    const sock = s.socket();
    sock.fire("call:incoming", { dmChannelId: "d1", from: { id: "u", username: "u" }, video: true });
    sock.fire("call:declined", { dmChannelId: "d1", by: { id: "u" } });
    sock.fire("call:ended", { dmChannelId: "d1" });
    sock.fire("call:ended", {});
    sock.fire("call:incoming", { dmChannelId: "d1" });
    expect(s.onCall.mock.calls.map((c) => c[0])).toEqual([
      { type: "incoming", dmChannelId: "d1", from: { id: "u", username: "u" }, video: true },
      { type: "declined", dmChannelId: "d1", by: { id: "u" } },
      { type: "ended", dmChannelId: "d1" },
    ]);
    const handlers = [...(sock.handlers.get("call:ended") ?? [])];
    s.rt.stop();
    handlers.forEach((fn) => fn({ dmChannelId: "d1" }));
    expect(s.onCall).toHaveBeenCalledTimes(3);
  });
});

describe("tracked text channels (unread) and activity", () => {
  async function connected() {
    const s = setup();
    s.rt.start();
    await flush();
    s.socket().accept();
    return s;
  }
  const subs = (sock: FakeSocket) => sock.subscribes().map((e) => (e.payload as { channelId: string }).channelId);
  const unsubs = (sock: FakeSocket) => sock.emitted.filter((e) => e.event === "channel:unsubscribe").map((e) => (e.payload as { channelId: string }).channelId);

  it("every event reaches onActivity (open or not, channel or DM), only the open one reaches onEvent", async () => {
    const s = await connected();
    s.rt.setConversation(channelKey("c1"));
    const sock = s.socket();
    sock.fire("message:new", msg("c2"));
    sock.fire("message:delete", { id: "m1", channelId: "c1" });
    sock.fire("dm:message:new", { ...msg("x"), channelId: null, dmChannelId: "d1" });
    expect(s.onActivity.mock.calls.map((c) => [c[0], c[1].type])).toEqual([
      [channelKey("c2"), "message:new"],
      [channelKey("c1"), "message:delete"],
      [dmKey("d1"), "message:new"],
    ]);
    expect(s.onEvent).toHaveBeenCalledTimes(1);
  });

  it("reaction events reach the open conversation as message:reaction (channel and DM)", async () => {
    const s = await connected();
    s.rt.setConversation(channelKey("c1"));
    const sock = s.socket();
    const change = { messageId: "m1", emoji: "👍", userId: "u", added: true, count: 1 };
    sock.fire("message:reaction", { ...change, channelId: "c1" });
    sock.fire("message:reaction", { ...change, channelId: "c2" }); // another conversation: activity only
    sock.fire("dm:message:reaction", { ...change, dmChannelId: "d1" });
    sock.fire("message:reaction", null);
    expect(s.onEvent.mock.calls).toEqual([[channelKey("c1"), { type: "message:reaction", reaction: { ...change, channelId: "c1" } }]]);
    expect(s.onActivity).toHaveBeenCalledTimes(3);
  });

  it("pin events reach the open conversation as message:pin (channel and DM)", async () => {
    const s = await connected();
    s.rt.setConversation(channelKey("c1"));
    const sock = s.socket();
    sock.fire("message:pin", { messageId: "m1", channelId: "c1", pinned: true });
    sock.fire("message:pin", { messageId: "m2", channelId: "c2", pinned: true }); // another conversation: activity only
    sock.fire("dm:message:pin", { messageId: "m3", dmChannelId: "d1", pinned: false });
    sock.fire("message:pin", null);
    expect(s.onEvent.mock.calls).toEqual([[channelKey("c1"), { type: "message:pin", pin: { messageId: "m1", channelId: "c1", pinned: true } }]]);
    expect(s.onActivity).toHaveBeenCalledTimes(3);
  });

  it("mention:new reaches onMention whatever is open; a malformed one is dropped", async () => {
    const s = await connected();
    const sock = s.socket();
    sock.fire("mention:new", { guildId: "g1", channelId: "c9", message: msg("c9") });
    sock.fire("mention:new", { guildId: "g1", message: { id: "x", channelId: null } });
    sock.fire("mention:new", { message: msg("c9") });
    sock.fire("mention:new", null);
    sock.fire("mention:new", { guildId: "g1", channelId: "t9", parentChannelId: "c9", message: msg("t9") });
    expect(s.onMention.mock.calls).toEqual([["g1", msg("c9"), null], ["g1", msg("t9"), "c9"]]);
    expect(s.onActivity).not.toHaveBeenCalled();
  });

  it("subscribes to the tracked set, resubscribes after a reconnect, drops removed ones, forgets refused ones", async () => {
    const s = await connected();
    s.rt.setTracked(["t1", "t2"]);
    expect(subs(s.socket())).toEqual(["t1", "t2"]);
    s.rt.setTracked(["t2", "t3"]);
    expect(unsubs(s.socket())).toEqual(["t1"]);
    s.socket().subscribes().find((e) => (e.payload as { channelId: string }).channelId === "t3")!.ack!({ ok: false });
    s.socket().drop();
    s.socket().accept();
    expect(subs(s.socket()).slice(3)).toEqual(["t2"]); // t3 was refused and is not retried
    s.rt.stop();
  });

  it("switching away from an open channel that is tracked keeps its subscription", async () => {
    const s = await connected();
    s.rt.setTracked(["t1", "t2"]);
    s.rt.setConversation(channelKey("t1"));
    s.rt.setConversation(channelKey("t2"));
    expect(unsubs(s.socket())).toEqual([]);
    s.rt.setConversation(channelKey("other"));
    expect(unsubs(s.socket())).toEqual([]); // t2 is tracked too
    s.rt.setConversation(null);
    expect(unsubs(s.socket())).toEqual(["other"]);
  });
});

describe("threads", () => {
  async function connected() {
    const s = setup();
    s.rt.start();
    await flush();
    s.socket().accept();
    return s;
  }
  const subs = (sock: FakeSocket) => sock.subscribes().map((e) => (e.payload as { channelId: string }).channelId);
  const unsubs = (sock: FakeSocket) => sock.emitted.filter((e) => e.event === "channel:unsubscribe").map((e) => (e.payload as { channelId: string }).channelId);
  const thread = { id: "t1", parentChannelId: "c1", guildId: "g1", name: "plans", starterMessageId: "m1", createdById: "u", createdAt: "2026-10-10T00:00:00Z", lastMessageAt: null, archived: false, messageCount: 0 };

  it("listens to the side panel's thread next to the main channel, both after a reconnect, and delivers both", async () => {
    const s = await connected();
    s.rt.setConversation(channelKey("c1"));
    s.rt.setConversation(channelKey("t1"), "side");
    expect(subs(s.socket())).toEqual(["c1", "t1"]);
    s.socket().subscribes().forEach((e) => e.ack?.({ ok: true }));
    expect(s.onSubscribed.mock.calls).toEqual([[channelKey("c1")], [channelKey("t1")]]);
    s.socket().fire("message:new", msg("t1"));
    s.socket().fire("message:new", msg("c1"));
    s.socket().fire("message:new", msg("elsewhere"));
    expect(s.onEvent.mock.calls.map(([key]) => key)).toEqual([channelKey("t1"), channelKey("c1")]);
    s.socket().drop();
    s.socket().accept();
    expect(subs(s.socket()).slice(2)).toEqual(["c1", "t1"]);
    s.rt.setConversation(null, "side");
    expect(unsubs(s.socket())).toEqual(["t1"]);
    s.rt.setConversation(channelKey("c1"), "side"); // the same conversation in both: no second subscribe, and closing one keeps it
    s.rt.setConversation(null, "side");
    expect(unsubs(s.socket())).toEqual(["t1"]);
  });

  it("passes thread events on and drops malformed ones", async () => {
    const s = await connected();
    const sock = s.socket();
    sock.fire("thread:created", thread);
    sock.fire("thread:updated", { ...thread, archived: true });
    sock.fire("thread:deleted", { id: "t1", guildId: "g1", parentChannelId: "c1", starterMessageId: "m1" });
    sock.fire("thread:created", { id: "t2" });
    sock.fire("thread:updated", null);
    sock.fire("thread:deleted", { parentChannelId: "c1" });
    expect(s.onThread.mock.calls).toEqual([
      [{ type: "thread:created", thread }],
      [{ type: "thread:updated", thread: { ...thread, archived: true } }],
      [{ type: "thread:deleted", gone: { id: "t1", guildId: "g1", parentChannelId: "c1", starterMessageId: "m1" } }],
    ]);
  });
});
