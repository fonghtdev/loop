import { EventEmitter } from "node:events";
import type { Channel } from "@loop/shared";
import { io, type Socket } from "socket.io-client";
import { Api, type Author, type Guild, type Message } from "./api.js";
import { VoiceConnection } from "./voice.js";

export type BotEvents = {
  ready: [];
  message: [message: Message];
  memberJoin: [event: { guildId: string; user: Author }];
  error: [error: Error];
  disconnect: [reason: string];
};

export interface LoopBot {
  on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this;
  once<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this;
  off<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** A bot account connected to a Loop server. Like any EventEmitter, an `error` nobody listens to throws. */
export class LoopBot extends EventEmitter {
  private readonly api: Api;
  private readonly apiUrl: string;
  private socket?: Socket;
  private stopped = false;
  private retryMs = BACKOFF_START_MS;
  private retryTimer?: NodeJS.Timeout;

  constructor({ apiUrl, token }: { apiUrl: string; token: string }) {
    super();
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.api = new Api(this.apiUrl, token);
  }

  /** The bot's own user id, known after `start()`. */
  get id() {
    return this.api.userId;
  }

  /** Logs in, connects the socket and subscribes every text channel; resolves at the first `ready` (which fires again after every reconnect). Rejects when the first login fails. */
  async start() {
    this.stopped = false;
    await this.api.login();
    this.openSocket();
    await new Promise<void>((resolve) => this.once("ready", resolve));
  }

  /** A fresh socket each time: a socket.io manager that gave up (handshake refused) does not reliably reopen. */
  private openSocket() {
    this.socket?.removeAllListeners().close();
    const socket = (this.socket = io(this.apiUrl, {
      forceNew: true,
      auth: (cb) => cb({ token: this.api.accessToken }),
      reconnectionDelay: BACKOFF_START_MS,
      reconnectionDelayMax: BACKOFF_MAX_MS,
    }));
    socket.on("connect", () => void this.onConnect());
    // refused by the handshake (expired or revoked token) or cut by the server: socket.io does not retry those itself
    socket.on("connect_error", (e) => {
      this.emit("error", e);
      if (!socket.active) this.scheduleReconnect(e.message === "Unauthorized");
    });
    socket.on("disconnect", (reason) => {
      this.emit("disconnect", reason);
      if (!socket.active) this.scheduleReconnect(false);
    });
    socket.on("message:new", (m: Message) => {
      if (m.author.id !== this.api.userId) this.emit("message", m);
    });
    socket.on("member:joined", (e: { guildId: string; user: Author }) => {
      if (e.user.id === this.api.userId) void this.subscribeGuild(e.guildId).catch((err) => this.emit("error", err));
      else this.emit("memberJoin", e);
    });
    socket.on("channel:created", (c: Channel) => {
      if (c.type === "TEXT") void this.subscribe(c.id).catch((err) => this.emit("error", err));
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
  }

  sendMessage = (channelId: string, content: string) => this.api.sendMessage(channelId, content);
  listGuilds = (): Promise<Guild[]> => this.api.listGuilds();
  listChannels = (guildId: string): Promise<Channel[]> => this.api.listChannels(guildId);

  /** Who is in a voice channel right now (needs VIEW). */
  voiceParticipants = (channelId: string) => this.api.voiceParticipants(channelId);

  /** Joins a voice channel. Throws ApiError (403 without CONNECT or SPEAK). */
  joinVoice = (channelId: string) => VoiceConnection.join(this.api, channelId);

  private scheduleReconnect(relogin: boolean) {
    if (this.stopped) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(wait * 2, BACKOFF_MAX_MS);
    this.retryTimer = setTimeout(async () => {
      try {
        if (relogin) await this.api.login();
        this.openSocket();
      } catch (e) {
        this.emit("error", e);
        this.scheduleReconnect(relogin);
      }
    }, wait);
  }

  private async onConnect() {
    this.retryMs = BACKOFF_START_MS;
    try {
      for (const guild of await this.api.listGuilds()) await this.subscribeGuild(guild.id);
    } catch (e) {
      return this.emit("error", e);
    }
    this.emit("ready");
  }

  private async subscribeGuild(guildId: string) {
    for (const c of await this.api.listChannels(guildId)) if (c.type === "TEXT") await this.subscribe(c.id);
  }

  private async subscribe(channelId: string) {
    const ack = await this.socket!.timeout(5000).emitWithAck("channel:subscribe", { channelId });
    if (!ack.ok) this.emit("error", new Error(`Cannot subscribe to ${channelId}: ${ack.error}`));
  }
}
