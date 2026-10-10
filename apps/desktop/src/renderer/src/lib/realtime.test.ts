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
    onSubscribed: vi.fn(),
    onRefused: vi.fn(),
    onSocial: vi.fn(),
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
    sock.fire("dm:new", { id: "d9", user: { id: "u", username: "u", online: true } });
    sock.fire("friend:request", { from: { id: "u", username: "u" } });
    sock.fire("friend:accepted", { user: { id: "u", username: "u" } });
    sock.fire("friend:removed", { userId: "u" });
    sock.fire("presence:update", { userId: "u", online: true });
    sock.fire("presence:update", { userId: "u", online: false });
    expect(s.onSocial.mock.calls.map((c) => c[0])).toEqual([
      { type: "dm:new", dm: { id: "d9", user: { id: "u", username: "u", online: true } } },
      { type: "friend:request", from: { id: "u", username: "u" } },
      { type: "friend:accepted", user: { id: "u", username: "u" } },
      { type: "friend:removed", userId: "u" },
      { type: "presence", userId: "u", online: true },
      { type: "presence", userId: "u", online: false },
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
    const handlers = ["dm:message:new", "dm:new", "friend:request", "friend:accepted", "friend:removed", "presence:update"].map((e) => [e, [...(sock.handlers.get(e) ?? [])]] as const);
    s.rt.stop();
    for (const [event, fns] of handlers) fns.forEach((fn) => fn(event === "dm:message:new" ? dmMsg("d1") : { from: { id: "u" }, user: { id: "u" }, userId: "u", id: "d", online: true }));
    expect(s.onSocial).not.toHaveBeenCalled();
    expect(s.onEvent).not.toHaveBeenCalled();
  });
});
