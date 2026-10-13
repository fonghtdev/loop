import { io as connectIo, type ManagerOptions, type SocketOptions } from "socket.io-client";
import { createStore } from "zustand/vanilla";
import type { LiveEvent as ChannelEvent, Message } from "./chat";
import { channelKey, dmKey, parseKey, type ConvKey } from "./conversation";
import type { CallEvent } from "./calls";
import type { GuildEvent } from "./categories";
import type { Friend, PublicUser, SocialEvent } from "./social";
import type { Seat } from "./voice-presence";

/** connecting: first attempt; online; reconnecting: lost or never reached (banner); failed: auth gave up (banner + retry). */
export type ConnectionStatus = "idle" | "connecting" | "online" | "reconnecting" | "failed";

/** The part of a socket.io-client Socket used here (tests pass a fake). */
export type SocketLike = {
  readonly active: boolean;
  readonly connected: boolean;
  on(event: string, fn: (...args: never[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  connect(): unknown;
  disconnect(): unknown;
  removeAllListeners(): unknown;
};
type Opts = Partial<ManagerOptions & SocketOptions>;

type Deps = {
  url: string;
  /**
   * The access token for a handshake. With `rejected` (the token the server just refused) it must return a fresh
   * one through the auth client's single-flight refresh. null = the session is over.
   */
  getToken: (rejected?: string) => Promise<string | null>;
  /** A live message event for the open conversation (events of other conversations are dropped here). */
  onEvent: (key: ConvKey, event: ChannelEvent) => void;
  /** Every live message event the socket delivers, whatever conversation (unread tracking and notifications). */
  onActivity: (key: ConvKey, event: ChannelEvent) => void;
  /**
   * The open conversation is listening (a channel: its subscription was acked; a DM: the socket connected, DM events
   * need no subscribe), first time and after every reconnect: time to catch up.
   */
  onSubscribed: (key: ConvKey) => void;
  /** The server refused the subscription (no VIEW any more, or the channel is gone). */
  onRefused: (key: ConvKey) => void;
  /** Friend, DM-list and presence events (they arrive whatever is open). */
  onSocial: (event: SocialEvent) => void;
  /** Channel and category changes of a server we are in (they arrive in the user's own room, whatever is open). */
  onGuild: (event: GuildEvent) => void;
  /** A watched voice channel was subscribed (first time and after every reconnect): fetch who is in it. */
  onWatched: (channelId: string) => void;
  /** The server refused a watched channel (no VIEW any more, or it is gone). */
  onWatchRefused: (channelId: string) => void;
  /** `voice:update` of a watched channel. */
  onVoiceUpdate: (channelId: string, seats: Seat[]) => void;
  /** Incoming / declined / ended DM calls (they arrive in the user's own room). */
  onCall: (event: CallEvent) => void;
  /** Connected again after a drop: permissions and lists may have changed meanwhile. */
  onReconnected: () => void;
  io?: (url: string, opts: Opts) => SocketLike;
  retryDelayMs?: number;
};

/**
 * Socket.IO lifecycle: push channel only (REST stays the source of truth).
 * - Every (re)connect attempt asks `getToken` through the `auth` callback, so a handshake never reuses a token
 *   the auth client has since replaced.
 * - A handshake refused as Unauthorized gets ONE retry with a refreshed token; refused again -> "failed" (no loop).
 *   Refusals stop socket.io's own reconnection, as does a server-side disconnect: those are retried here with backoff.
 * - Voice presence: `voice:update` goes only to sockets subscribed to the voice channel's room, so the visible voice
 *   channels of the selected server are a watched set, resubscribed after every reconnect like the open channel.
 * - The server never subscribes by itself: the open channel is (re)subscribed on every connect. A DM needs no
 *   subscribe (every socket is in the user's own room); friend, DM and presence events arrive in that room.
 */
export function createRealtime({ url, getToken, onEvent, onActivity, onSubscribed, onRefused, onSocial, onGuild, onWatched, onWatchRefused, onVoiceUpdate, onCall, onReconnected, io = connectIo, retryDelayMs = 1000 }: Deps) {
  const state = createStore<{ status: ConnectionStatus }>(() => ({ status: "idle" }));
  const setStatus = (status: ConnectionStatus) => state.setState({ status });
  let socket: SocketLike | null = null;
  let openKey: ConvKey | null = null;
  let watched = new Set<string>();
  let tracked = new Set<string>(); // text channels of the open server, listened to for unread counts only
  let sent: string | null = null; // the token of the latest handshake
  let authRetried = false;
  let everConnected = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const subscribe = (s: SocketLike, key: ConvKey) => {
    const { kind, id } = parseKey(key);
    if (kind === "dm") return onSubscribed(key);
    s.emit("channel:subscribe", { channelId: id }, (ack?: { ok: boolean }) => {
      if (s !== socket || openKey !== key) return; // stopped, or the user moved on
      if (ack?.ok) onSubscribed(key);
      else onRefused(key);
    });
  };

  const watch = (s: SocketLike, channelId: string) =>
    s.emit("channel:subscribe", { channelId }, (ack?: { ok: boolean }) => {
      if (s !== socket || !watched.has(channelId)) return;
      if (ack?.ok) return onWatched(channelId);
      watched.delete(channelId); // refused: not retried until the set is set again
      onWatchRefused(channelId);
    });

  const track = (s: SocketLike, channelId: string) =>
    s.emit("channel:subscribe", { channelId }, (ack?: { ok: boolean }) => {
      if (s === socket && !ack?.ok) tracked.delete(channelId); // refused: no unread for it
    });
  const listened = (id: string) => watched.has(id) || tracked.has(id) || (!!openKey && openKey === channelKey(id));

  const retryLater = (s: SocketLike) => {
    clearTimeout(timer);
    const delay = retryDelayMs * Math.min(2 ** retries++, 16);
    timer = setTimeout(() => s === socket && s.connect(), delay);
  };

  async function onConnectError(s: SocketLike, err: Error) {
    if (s !== socket) return;
    if (state.getState().status !== "failed") setStatus("reconnecting");
    if (s.active) return; // a transport problem: socket.io retries by itself (asking getToken again)
    if (err.message !== "Unauthorized" || sent === null) return retryLater(s); // other refusal, or no token (offline)
    if (authRetried) return setStatus("failed"); // a freshly refreshed token was refused too: stop
    authRetried = true;
    let fresh: string | null;
    try {
      fresh = await getToken(sent);
    } catch {
      return retryLater(s); // refresh unreachable: offline is not signed out
    }
    if (s !== socket) return;
    if (fresh === null) return stop(); // refresh rejected: the session is over (the auth client signs out)
    s.connect();
  }

  function start() {
    if (socket) return;
    setStatus("connecting");
    const s = io(url, {
      autoConnect: false,
      auth: (cb) => {
        getToken()
          .catch(() => null)
          .then((token) => {
            sent = token;
            cb(token ? { token } : {});
          });
      },
    });
    socket = s;
    s.on("connect", () => {
      if (s !== socket) return;
      setStatus("online");
      authRetried = false;
      retries = 0;
      if (everConnected) onReconnected();
      everConnected = true;
      if (openKey) subscribe(s, openKey);
      for (const id of watched) watch(s, id);
      for (const id of tracked) track(s, id);
    });
    s.on("connect_error", (err: Error) => void onConnectError(s, err));
    s.on("disconnect", () => {
      if (s !== socket) return;
      setStatus("reconnecting");
      if (!s.active) retryLater(s); // "io server disconnect" (e.g. a server restart): socket.io would not come back
    });
    const dispatch = (key: ConvKey | null, event: ChannelEvent) => {
      if (s !== socket || !key) return;
      onActivity(key, event);
      if (key === openKey) onEvent(key, event);
    };
    const social = (event: SocialEvent) => s === socket && onSocial(event);
    const channelOf = (id: string | null | undefined) => (id ? channelKey(id) : null);
    const dmOf = (id: string | null | undefined) => (id ? dmKey(id) : null);
    s.on("message:new", (m: Message) => dispatch(channelOf(m?.channelId), { type: "message:new", message: m }));
    s.on("message:update", (m: Message) => dispatch(channelOf(m?.channelId), { type: "message:update", message: m }));
    s.on("message:delete", (d: { id: string; channelId: string }) => dispatch(channelOf(d?.channelId), { type: "message:delete", id: d?.id }));
    s.on("dm:message:new", (m: Message) => {
      dispatch(dmOf(m?.dmChannelId), { type: "message:new", message: m });
      if (m?.dmChannelId) social({ type: "dm:message", message: m });
    });
    s.on("dm:message:update", (m: Message) => dispatch(dmOf(m?.dmChannelId), { type: "message:update", message: m }));
    s.on("dm:message:delete", (d: { id: string; dmChannelId: string }) => dispatch(dmOf(d?.dmChannelId), { type: "message:delete", id: d?.id }));
    s.on("dm:new", (d: { id: string; user: Friend }) => d?.id && d.user && social({ type: "dm:new", dm: d }));
    s.on("friend:request", (d: { from: PublicUser }) => d?.from && social({ type: "friend:request", from: d.from }));
    s.on("friend:accepted", (d: { user: PublicUser }) => d?.user && social({ type: "friend:accepted", user: d.user }));
    s.on("friend:removed", (d: { userId: string }) => d?.userId && social({ type: "friend:removed", userId: d.userId }));
    s.on("presence:update", (d: { userId: string; online: boolean }) => d?.userId && social({ type: "presence", userId: d.userId, online: d.online === true }));
    const guild = (event: GuildEvent) => s === socket && onGuild(event);
    s.on("channel:created", (d: Extract<GuildEvent, { type: "channel:created" }>["channel"]) => d?.id && guild({ type: "channel:created", channel: d }));
    s.on("category:created", (d: Extract<GuildEvent, { type: "category:created" }>["category"]) => d?.id && guild({ type: "category:created", category: d }));
    s.on("category:updated", (d: Extract<GuildEvent, { type: "category:updated" }>["category"]) => d?.id && guild({ type: "category:updated", category: d }));
    s.on("category:deleted", (d: Extract<GuildEvent, { type: "category:deleted" }>["event"]) => d?.categoryId && Array.isArray(d.channels) && guild({ type: "category:deleted", event: d }));
    s.on("layout:updated", (d: Extract<GuildEvent, { type: "layout:updated" }>["event"]) => d?.guildId && Array.isArray(d.categories) && Array.isArray(d.channels) && guild({ type: "layout:updated", event: d }));
    s.on("voice:update", (d: { channelId: string; participants: Seat[] }) => {
      if (s === socket && d && watched.has(d.channelId) && Array.isArray(d.participants)) onVoiceUpdate(d.channelId, d.participants);
    });
    const call = (event: CallEvent) => s === socket && onCall(event);
    s.on("call:incoming", (d: { dmChannelId: string; from: PublicUser; video: boolean }) => d?.dmChannelId && d.from && call({ type: "incoming", dmChannelId: d.dmChannelId, from: d.from, video: d.video === true }));
    s.on("call:declined", (d: { dmChannelId: string; by: { id: string } }) => d?.dmChannelId && call({ type: "declined", dmChannelId: d.dmChannelId, by: d.by }));
    s.on("call:ended", (d: { dmChannelId: string }) => d?.dmChannelId && call({ type: "ended", dmChannelId: d.dmChannelId }));
    s.connect();
  }

  function stop() {
    clearTimeout(timer);
    const s = socket;
    socket = null; // every handler checks this first: nothing is processed after sign-out
    openKey = null;
    watched = new Set();
    tracked = new Set();
    sent = null;
    authRetried = false;
    everConnected = false;
    retries = 0;
    s?.removeAllListeners();
    s?.disconnect();
    setStatus("idle");
  }

  return {
    state,
    start,
    stop,
    /** The conversation on screen (null = none): a previous channel is left, this one listened to now and on every reconnect. */
    setConversation(key: ConvKey | null) {
      if (key === openKey) return;
      const previous = openKey && parseKey(openKey);
      openKey = key;
      if (socket?.connected && previous?.kind === "channel" && !listened(previous.id)) socket.emit("channel:unsubscribe", { channelId: previous.id });
      if (socket?.connected && key) subscribe(socket, key);
    },
    /** The voice channels whose `voice:update` we want (the selected server's); [] = none. Leaves the ones dropped. */
    setWatched(channelIds: string[]) {
      const next = new Set(channelIds);
      const s = socket?.connected ? socket : null;
      for (const id of watched) if (s && !next.has(id) && openKey !== channelKey(id)) s.emit("channel:unsubscribe", { channelId: id });
      const added = [...next].filter((id) => !watched.has(id));
      watched = next;
      if (s) for (const id of added) watch(s, id);
    },
    /** The text channels whose messages we count as unread (the selected server's); [] = none. Leaves the ones dropped. */
    setTracked(channelIds: string[]) {
      const next = new Set(channelIds);
      const s = socket?.connected ? socket : null;
      const dropped = [...tracked].filter((id) => !next.has(id));
      const added = [...next].filter((id) => !tracked.has(id));
      tracked = next;
      if (s) {
        for (const id of dropped) if (!listened(id)) s.emit("channel:unsubscribe", { channelId: id });
        for (const id of added) track(s, id);
      }
    },
    /** "Try again" after `failed`. */
    retry() {
      if (!socket) return;
      authRetried = false;
      setStatus("connecting");
      socket.connect();
    },
  };
}
