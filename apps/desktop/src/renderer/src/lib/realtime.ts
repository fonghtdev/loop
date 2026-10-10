import { io as connectIo, type ManagerOptions, type SocketOptions } from "socket.io-client";
import { createStore } from "zustand/vanilla";
import type { LiveEvent as ChannelEvent, Message } from "./chat";

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
  /** A live event for the open channel (events of other channels are dropped here). */
  onEvent: (channelId: string, event: ChannelEvent) => void;
  /** The open channel's subscription was acked (first time and after every reconnect): time to catch up. */
  onSubscribed: (channelId: string) => void;
  /** The server refused the subscription (no VIEW any more, or the channel is gone). */
  onRefused: (channelId: string) => void;
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
 * - The server never subscribes by itself: the open channel is (re)subscribed on every connect.
 */
export function createRealtime({ url, getToken, onEvent, onSubscribed, onRefused, onReconnected, io = connectIo, retryDelayMs = 1000 }: Deps) {
  const state = createStore<{ status: ConnectionStatus }>(() => ({ status: "idle" }));
  const setStatus = (status: ConnectionStatus) => state.setState({ status });
  let socket: SocketLike | null = null;
  let openChannel: string | null = null;
  let sent: string | null = null; // the token of the latest handshake
  let authRetried = false;
  let everConnected = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const subscribe = (s: SocketLike, channelId: string) =>
    s.emit("channel:subscribe", { channelId }, (ack?: { ok: boolean }) => {
      if (s !== socket || openChannel !== channelId) return; // stopped, or the user moved on
      if (ack?.ok) onSubscribed(channelId);
      else onRefused(channelId);
    });

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
      if (openChannel) subscribe(s, openChannel);
    });
    s.on("connect_error", (err: Error) => void onConnectError(s, err));
    s.on("disconnect", () => {
      if (s !== socket) return;
      setStatus("reconnecting");
      if (!s.active) retryLater(s); // "io server disconnect" (e.g. a server restart): socket.io would not come back
    });
    const forOpen = (channelId: string | null | undefined, event: ChannelEvent) => {
      if (s === socket && channelId && channelId === openChannel) onEvent(channelId, event);
    };
    s.on("message:new", (m: Message) => forOpen(m?.channelId, { type: "message:new", message: m }));
    s.on("message:update", (m: Message) => forOpen(m?.channelId, { type: "message:update", message: m }));
    s.on("message:delete", (d: { id: string; channelId: string }) => forOpen(d?.channelId, { type: "message:delete", id: d?.id }));
    s.connect();
  }

  function stop() {
    clearTimeout(timer);
    const s = socket;
    socket = null; // every handler checks this first: nothing is processed after sign-out
    openChannel = null;
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
    /** The channel on screen (null = none): the previous one is left, this one subscribed now and on every reconnect. */
    setChannel(channelId: string | null) {
      if (channelId === openChannel) return;
      if (socket?.connected && openChannel) socket.emit("channel:unsubscribe", { channelId: openChannel });
      openChannel = channelId;
      if (socket?.connected && channelId) subscribe(socket, channelId);
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
