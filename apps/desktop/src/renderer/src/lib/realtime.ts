import { io as connectIo, type ManagerOptions, type SocketOptions } from "socket.io-client";
import { createStore } from "zustand/vanilla";
import type { LiveEvent as ChannelEvent, Message, PinEvent, ReactionEvent } from "./chat";
import { channelKey, dmKey, parseKey, type ConvKey } from "./conversation";
import type { CallEvent } from "./calls";
import type { GuildEvent } from "./categories";
import { asPref, asStatus } from "./presence";
import { parseGuildUpdated, parseUserUpdated } from "./identity";
import type { GuildUpdatedEvent, StatusPref, UserUpdatedEvent } from "@loop/shared";
import type { Friend, GroupDm, PublicUser, SocialEvent } from "./social";
import type { Seat } from "./voice-presence";
import type { ThreadEvent } from "./threads";

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
  /** A live message event for an open conversation, main or side (events of other conversations are dropped here). */
  onEvent: (key: ConvKey, event: ChannelEvent) => void;
  /** Every live message event the socket delivers, whatever conversation (unread tracking and notifications). */
  onActivity: (key: ConvKey, event: ChannelEvent) => void;
  /** A message in a channel names me (`mention:new`, in the user's own room, so it arrives for channels that are not open). */
  onMention: (guildId: string, message: Message, parentChannelId: string | null) => void;
  /**
   * The open conversation is listening (a channel: its subscription was acked; a DM: the socket connected, DM events
   * need no subscribe), first time and after every reconnect: time to catch up.
   */
  onSubscribed: (key: ConvKey) => void;
  /** The server refused the subscription (no VIEW any more, or the channel is gone). */
  onRefused: (key: ConvKey) => void;
  /** Friend, DM-list and presence events (they arrive whatever is open). */
  onSocial: (event: SocialEvent) => void;
  /** The user's own status choice was changed from another device (`me:status`). */
  onMyStatus: (pref: StatusPref) => void;
  /** Channel and category changes of a server we are in (they arrive in the user's own room, whatever is open). */
  onGuild: (event: GuildEvent) => void;
  /** Someone changed their profile (name, avatar, banner, status text), or we did from another device. */
  onUserUpdated: (event: UserUpdatedEvent) => void;
  /** A server we are in was renamed or got a new icon. */
  onGuildUpdated: (event: GuildUpdatedEvent) => void;
  /** A watched voice channel was subscribed (first time and after every reconnect): fetch who is in it. */
  onWatched: (channelId: string) => void;
  /** The server refused a watched channel (no VIEW any more, or it is gone). */
  onWatchRefused: (channelId: string) => void;
  /** `voice:update` of a watched channel. */
  onVoiceUpdate: (channelId: string, seats: Seat[]) => void;
  /** Incoming / declined / ended DM calls (they arrive in the user's own room). */
  onCall: (event: CallEvent) => void;
  /** Someone with MOVE_MEMBERS moved us to another voice channel (`voice:moved`, in the user's own room). */
  onVoiceMoved: (event: { channelId: string; byName: string }) => void;
  /** A moderator changed our server mute / deafen (`voice:moderated`, in the user's own room). */
  onVoiceModerated?: (event: { channelId: string; serverMute: boolean; serverDeafen: boolean; byName: string }) => void;
  /** Someone is typing in a conversation (`typing`; a channel's arrives only while it is subscribed, a DM's always). */
  onTyping: (key: ConvKey, userId: string) => void;
  /** Another device (or this one) read a conversation up to `lastReadSeq` (`read:updated`, in the user's own room). */
  onRead: (key: ConvKey, lastReadSeq: string) => void;
  /** A thread was created, changed (renamed, archived, got a message) or deleted (`thread:*`). */
  onThread: (event: ThreadEvent) => void;
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
/** Where a conversation is on screen: the main area, or the side panel (an open thread next to its channel). */
export type Slot = "main" | "side";

export function createRealtime({ url, getToken, onEvent, onActivity, onMention, onSubscribed, onRefused, onSocial, onMyStatus, onGuild, onUserUpdated, onGuildUpdated, onWatched, onWatchRefused, onVoiceUpdate, onCall, onVoiceMoved, onVoiceModerated, onTyping, onRead, onThread, onReconnected, io = connectIo, retryDelayMs = 1000 }: Deps) {
  const state = createStore<{ status: ConnectionStatus }>(() => ({ status: "idle" }));
  const setStatus = (status: ConnectionStatus) => state.setState({ status });
  let socket: SocketLike | null = null;
  let open: Record<Slot, ConvKey | null> = { main: null, side: null };
  const isOpen = (key: ConvKey) => open.main === key || open.side === key;
  let watched = new Set<string>();
  let tracked = new Set<string>(); // text channels of the open server, listened to for unread counts only
  let away = false; // the system is idle; kept across stop() (an account switch on an idle machine stays away)
  let sent: string | null = null; // the token of the latest handshake
  let authRetried = false;
  let everConnected = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const subscribe = (s: SocketLike, key: ConvKey) => {
    const { kind, id } = parseKey(key);
    if (kind === "dm") return onSubscribed(key);
    s.emit("channel:subscribe", { channelId: id }, (ack?: { ok: boolean }) => {
      if (s !== socket || !isOpen(key)) return; // stopped, or the user moved on
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
  const listened = (id: string) => watched.has(id) || tracked.has(id) || isOpen(channelKey(id));

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
      if (away) s.emit("presence:away", { away }); // the server's flag is per socket and starts false
      for (const key of new Set([open.main, open.side])) if (key) subscribe(s, key);
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
      if (isOpen(key)) onEvent(key, event);
    };
    const social = (event: SocialEvent) => s === socket && onSocial(event);
    const channelOf = (id: string | null | undefined) => (id ? channelKey(id) : null);
    const dmOf = (id: string | null | undefined) => (id ? dmKey(id) : null);
    s.on("message:new", (m: Message) => dispatch(channelOf(m?.channelId), { type: "message:new", message: m }));
    s.on("message:update", (m: Message) => dispatch(channelOf(m?.channelId), { type: "message:update", message: m }));
    s.on("message:delete", (d: { id: string; channelId: string }) => dispatch(channelOf(d?.channelId), { type: "message:delete", id: d?.id }));
    s.on("message:reaction", (d: ReactionEvent & { channelId: string }) => dispatch(channelOf(d?.channelId), { type: "message:reaction", reaction: d }));
    s.on("message:pin", (d: PinEvent & { channelId: string }) => dispatch(channelOf(d?.channelId), { type: "message:pin", pin: d }));
    s.on("dm:message:pin", (d: PinEvent & { dmChannelId: string }) => dispatch(dmOf(d?.dmChannelId), { type: "message:pin", pin: d }));
    s.on("mention:new", (d: { guildId: string; message: Message; parentChannelId?: unknown }) => {
      if (s === socket && typeof d?.guildId === "string" && d.message?.channelId) onMention(d.guildId, d.message, typeof d.parentChannelId === "string" ? d.parentChannelId : null);
    });
    s.on("dm:message:reaction", (d: ReactionEvent & { dmChannelId: string }) => dispatch(dmOf(d?.dmChannelId), { type: "message:reaction", reaction: d }));
    s.on("dm:message:new", (m: Message) => {
      dispatch(dmOf(m?.dmChannelId), { type: "message:new", message: m });
      if (m?.dmChannelId) social({ type: "dm:message", message: m });
    });
    s.on("dm:message:update", (m: Message) => dispatch(dmOf(m?.dmChannelId), { type: "message:update", message: m }));
    s.on("dm:message:delete", (d: { id: string; dmChannelId: string }) => dispatch(dmOf(d?.dmChannelId), { type: "message:delete", id: d?.id }));
    const group = (d: GroupDm) => d?.kind === "GROUP" && typeof d.id === "string" && Array.isArray(d.participants) && social({ type: "dm:group", dm: d });
    // dm:new is a pair `{id, user}` or, when we were added to a group, the group itself
    s.on("dm:new", (d: { id: string; user: Friend } & GroupDm) => (d?.kind === "GROUP" ? group(d) : d?.id && d.user && social({ type: "dm:new", dm: d })));
    s.on("dm:updated", group);
    s.on("dm:removed", (d: { dmChannelId: string }) => typeof d?.dmChannelId === "string" && social({ type: "dm:removed", dmChannelId: d.dmChannelId }));
    s.on("friend:request", (d: { from: PublicUser }) => d?.from && social({ type: "friend:request", from: d.from }));
    s.on("friend:accepted", (d: { user: PublicUser }) => d?.user && social({ type: "friend:accepted", user: d.user }));
    s.on("friend:removed", (d: { userId: string }) => d?.userId && social({ type: "friend:removed", userId: d.userId }));
    s.on("presence:update", (d: { userId: string; status: unknown }) => d?.userId && social({ type: "presence", userId: d.userId, status: asStatus(d.status) }));
    s.on("me:status", (d: { status: unknown }) => {
      const pref = asPref(d?.status);
      if (s === socket && pref) onMyStatus(pref);
    });
    const guild = (event: GuildEvent) => s === socket && onGuild(event);
    s.on("channel:created", (d: Extract<GuildEvent, { type: "channel:created" }>["channel"]) => d?.id && guild({ type: "channel:created", channel: d }));
    s.on("channel:updated", (d: Extract<GuildEvent, { type: "channel:updated" }>["channel"]) => d?.id && guild({ type: "channel:updated", channel: d }));
    s.on("user:updated", (d: unknown) => {
      const e = parseUserUpdated(d);
      if (s === socket && e) onUserUpdated(e);
    });
    s.on("guild:updated", (d: unknown) => {
      const e = parseGuildUpdated(d);
      if (s === socket && e) onGuildUpdated(e);
    });
    s.on("category:created", (d: Extract<GuildEvent, { type: "category:created" }>["category"]) => d?.id && guild({ type: "category:created", category: d }));
    s.on("category:updated", (d: Extract<GuildEvent, { type: "category:updated" }>["category"]) => d?.id && guild({ type: "category:updated", category: d }));
    s.on("category:deleted", (d: Extract<GuildEvent, { type: "category:deleted" }>["event"]) => d?.categoryId && Array.isArray(d.channels) && guild({ type: "category:deleted", event: d }));
    s.on("layout:updated", (d: Extract<GuildEvent, { type: "layout:updated" }>["event"]) => d?.guildId && Array.isArray(d.categories) && Array.isArray(d.channels) && guild({ type: "layout:updated", event: d }));
    s.on("roles:updated", (d: { guildId: unknown }) => typeof d?.guildId === "string" && guild({ type: "roles:updated", guildId: d.guildId }));
    s.on("voice:update", (d: { channelId: string; participants: Seat[] }) => {
      if (s === socket && d && watched.has(d.channelId) && Array.isArray(d.participants)) onVoiceUpdate(d.channelId, d.participants);
    });
    s.on("voice:moved", (d: { channelId: string; by: { username: string } }) => {
      if (s === socket && typeof d?.channelId === "string" && typeof d.by?.username === "string") onVoiceMoved({ channelId: d.channelId, byName: d.by.username });
    });
    s.on("voice:moderated", (d: { channelId?: unknown; serverMute?: unknown; serverDeafen?: unknown; by?: { username?: unknown } }) => {
      if (s !== socket || typeof d?.channelId !== "string" || typeof d.serverMute !== "boolean" || typeof d.serverDeafen !== "boolean" || typeof d.by?.username !== "string") return;
      onVoiceModerated?.({ channelId: d.channelId, serverMute: d.serverMute, serverDeafen: d.serverDeafen, byName: d.by.username });
    });
    s.on("typing", (d: { channelId?: unknown; dmChannelId?: unknown; userId?: unknown }) => {
      const key = typeof d?.channelId === "string" ? channelKey(d.channelId) : typeof d?.dmChannelId === "string" ? dmKey(d.dmChannelId) : null;
      if (s === socket && key && typeof d.userId === "string") onTyping(key, d.userId);
    });
    s.on("read:updated", (d: { channelId?: unknown; dmChannelId?: unknown; lastReadSeq?: unknown }) => {
      const key = typeof d?.channelId === "string" ? channelKey(d.channelId) : typeof d?.dmChannelId === "string" ? dmKey(d.dmChannelId) : null;
      if (s === socket && key && typeof d.lastReadSeq === "string" && /^\d+$/.test(d.lastReadSeq)) onRead(key, d.lastReadSeq);
    });
    // a thread's JSON comes in its user room (created / renamed / archived) and in its parent's room (a message came or went)
    const thread = (type: "thread:created" | "thread:updated") => (d: Extract<ThreadEvent, { thread: unknown }>["thread"]) =>
      s === socket && typeof d?.id === "string" && typeof d.parentChannelId === "string" && onThread({ type, thread: d });
    s.on("thread:created", thread("thread:created"));
    s.on("thread:updated", thread("thread:updated"));
    s.on("thread:deleted", (d: Extract<ThreadEvent, { type: "thread:deleted" }>["gone"]) => s === socket && typeof d?.id === "string" && typeof d.parentChannelId === "string" && onThread({ type: "thread:deleted", gone: d }));
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
    open = { main: null, side: null };
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
    /**
     * The conversation on screen in `slot` (null = none): a previous channel is left (unless still listened to for
     * another reason), this one listened to now and on every reconnect.
     */
    setConversation(key: ConvKey | null, slot: Slot = "main") {
      if (key === open[slot]) return;
      const previous = open[slot] && parseKey(open[slot]);
      const already = !!key && isOpen(key);
      open = { ...open, [slot]: key };
      if (socket?.connected && previous?.kind === "channel" && !listened(previous.id)) socket.emit("channel:unsubscribe", { channelId: previous.id });
      if (socket?.connected && key && !already) subscribe(socket, key);
    },
    /** The voice channels whose `voice:update` we want (the selected server's); [] = none. Leaves the ones dropped. */
    setWatched(channelIds: string[]) {
      const next = new Set(channelIds);
      const s = socket?.connected ? socket : null;
      for (const id of watched) if (s && !next.has(id) && !isOpen(channelKey(id))) s.emit("channel:unsubscribe", { channelId: id });
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
    /** The user is typing in `key`: told to the server (it relays to whoever could read a message from them); dropped when offline. */
    sendTyping(key: ConvKey) {
      if (!socket?.connected) return;
      const { kind, id } = parseKey(key);
      socket.emit("typing", kind === "dm" ? { dmChannelId: id } : { channelId: id });
    },
    /** The system went idle / came back: told to the server now (if connected) and again after every reconnect. */
    setAway(next: boolean) {
      if (next === away) return;
      away = next;
      if (socket?.connected) socket.emit("presence:away", { away });
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
