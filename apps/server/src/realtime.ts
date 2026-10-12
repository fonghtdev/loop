import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { z } from "zod";
import { verifyAccessToken } from "./auth/tokens.js";
import { HttpError } from "./http.js";
import { hiddenChannels, requireChannelPermission } from "./guilds/access.js";
import type { Limits } from "./limiter.js";
import { friendIds } from "./social/access.js";
import type { Voice } from "./voice/enforce.js";

declare module "fastify" {
  interface FastifyInstance {
    realtime: Realtime;
  }
}

/**
 * Socket.IO is only a push channel: writes and history go through REST.
 * Client -> server: `channel:subscribe` / `channel:unsubscribe` {channelId}, acked {ok:true} | {ok:false,error}.
 * Server -> room `channel:<id>`: `message:new` | `message:update` (message JSON as in REST), `message:delete` {id, channelId}.
 * The sender receives its own events too; clients dedupe by message id.
 * User rooms `user:<id>` (every authenticated socket joins its own) carry DM, friend and presence events:
 * `dm:message:new|update` (message JSON), `dm:message:delete` {id, dmChannelId}, `dm:new` {id, user},
 * `friend:request` {from}, `friend:accepted` {user}, `friend:removed` {userId}, `presence:update` {userId, online},
 * `call:incoming` {dmChannelId, from, video}, `call:declined` {dmChannelId, by}, `call:ended` {dmChannelId}.
 * Rooms span instances through the Redis adapter.
 */
export type MessageEvent = "message:new" | "message:update" | "message:delete";
/** Also pushed to room `channel:<id>` of a voice channel: `voice:update` {channelId, participants:[{userId, username}]}. */
export type ChannelEvent = MessageEvent | "voice:update";

const channelRoom = (channelId: string) => `channel:${channelId}`;
const userRoom = (userId: string) => `user:${userId}`;
const subscribeSchema = z.object({ channelId: z.string() });

export function createRealtime(httpServer: HttpServer, jwtSecret: string, redisUrl: string, voice: Voice, corsOrigins: string[], limits: Limits) {
  const pub = new Redis(redisUrl);
  const sub = pub.duplicate();
  const io = new Server(httpServer, { adapter: createAdapter(pub, sub), cors: { origin: corsOrigins } });

  // Never an empty list: Socket.IO treats `to([])` / `in([])` as "everyone".
  const emitToUsers = (userIds: string[], event: string, payload: object) => {
    if (userIds.length) io.to(userIds.map(userRoom)).emit(event, payload);
  };

  /** Users with at least one socket on any instance, asked of the adapter: nothing to go stale after a crash. */
  const onlineIds = async (userIds: string[]) => {
    if (!userIds.length) return new Set<string>();
    const sockets = await io.in(userIds.map(userRoom)).fetchSockets();
    return new Set<string>(sockets.map((s) => s.data.userId));
  };

  const announce = async (userId: string, online: boolean) => {
    emitToUsers(await friendIds(userId), "presence:update", { userId, online });
  };
  // ponytail: presence = first socket up (0 -> 1) / last socket down (1 -> 0) as seen by the adapter, friends only,
  // online/offline only (no idle/dnd; guild member-list presence comes with the client). Two first connects (or
  // last disconnects) on different instances in the same instant can both see 2 (or 1) and send nothing, and a
  // crashed instance sends no offline; lists always recompute, so the ceiling is a stale live dot until the next
  // fetch. Upgrade = a TTL'd presence key in Redis with heartbeats. Best effort: failures are swallowed.
  // Presence work talks to Redis through the adapter, so `close` must let it finish before quitting the clients
  // (a command queued on a closing connection rejects inside the adapter, where nobody can catch it).
  // ponytail: the wait is capped at 1 s because a peer that is closing too never answers `fetchSockets` (the
  // adapter would wait its full 5 s); a request still pending after the cap only ends by its own timeout, which
  // our `.catch` swallows. Ceiling = a peer that stalls mid-shutdown; upgrade = a shorter `requestsTimeout`.
  const DRAIN_MS = 1000;
  let closing = false;
  const presenceTasks = new Set<Promise<void>>();
  const trackPresence = (userId: string, up: boolean) => {
    if (closing) return;
    const task = (async () => {
      const count = (await io.in(userRoom(userId)).fetchSockets()).length;
      if (count === (up ? 1 : 0)) await announce(userId, up);
    })().catch(() => {});
    presenceTasks.add(task);
    void task.then(() => presenceTasks.delete(task));
  };

  // ponytail: the token is only checked at handshake, so a socket outlives the 15 min access token;
  // ceiling = expiry/revocation latency, upgrade = periodic re-auth or short-lived socket tickets
  io.use(async (socket, next) => {
    const { headers, address } = socket.handshake;
    if (await limits.hit("socket-connect", limits.socketIp(headers, address))) return next(new Error("Too many requests"));
    const token = socket.handshake.auth.token;
    const userId = typeof token === "string" ? await verifyAccessToken(token, jwtSecret) : null;
    if (!userId) return next(new Error("Unauthorized"));
    socket.data.userId = userId;
    next();
  });

  io.on("connection", (socket) => {
    const userId: string = socket.data.userId;
    socket.join(userRoom(userId));
    socket.on("disconnect", () => trackPresence(userId, false));

    const subscribeAllowed = limits.socketBudget(); // ponytail: per socket and in memory; reconnecting resets it, but connects are limited per IP
    const handle = (action: "join" | "leave") => async (payload: unknown, ack?: unknown) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        if (!subscribeAllowed()) return reply({ ok: false, error: "Too many requests" });
        const parsed = subscribeSchema.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, error: "Invalid request" });
        const { channelId } = parsed.data;
        if (action === "join") {
          await requireChannelPermission(channelId, userId);
          await socket.join(channelRoom(channelId));
        } else {
          await socket.leave(channelRoom(channelId));
        }
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false, error: e instanceof HttpError ? e.message : "Internal error" });
      }
    };
    socket.on("channel:subscribe", handle("join"));
    socket.on("channel:unsubscribe", handle("leave"));
    trackPresence(userId, true);
  });

  // The cluster adapter applies a leave locally only AFTER its Redis publish returns, so do the local part
  // first: this instance's sockets are cut off before the caller's request finishes; other instances follow
  // within a pub/sub hop (ponytail: that hop is the revoke latency across instances).
  const socketsLeave = (inRoom: string, rooms: string[]) => {
    io.local.in(inRoom).socketsLeave(rooms);
    io.in(inRoom).socketsLeave(rooms);
  };

  /** A user lost access to these channels: drop all their sockets from the rooms. */
  const leaveChannels = (userId: string, channelIds: string[]) => {
    socketsLeave(userRoom(userId), channelIds.map(channelRoom));
  };

  return {
    emit: (channelId: string, event: ChannelEvent, payload: object) => {
      io.to(channelRoom(channelId)).emit(event, payload);
    },
    emitToUsers,
    /** Liveness probe of the shared Redis connection (used by GET /health). */
    ping: () => pub.ping(),
    /** Both participants' user rooms; no subscribe step. */
    emitDm: (dm: { userLowId: string; userHighId: string }, event: "new" | "update" | "delete", payload: object) =>
      emitToUsers([dm.userLowId, dm.userHighId], `dm:message:${event}`, payload),
    onlineIds,
    /** Sockets out of the channel rooms, and the user out of any voice room among them. */
    leaveChannels: (userId: string, channelIds: string[]) => {
      leaveChannels(userId, channelIds);
      void voice.removeUser(userId, channelIds);
    },
    /**
     * Something may have taken VIEW_CHANNEL away (role/overwrite change, ownership transfer): recompute it for
     * these members (default: all) and drop their sockets from every room they can no longer see.
     * Voice sessions are re-checked the same way (CONNECT, SPEAK, VIDEO too): removed or downgraded in LiveKit.
     * Call after the change commits. A subscribe racing with the change can still slip in before this runs.
     */
    // ponytail: recomputes members x channels per call; fine for small guilds, upgrade = scope to the changed role's holders/channel
    revalidate: async (guildId: string, userIds?: string[]) => {
      for (const { userId, channelIds } of await hiddenChannels(guildId, userIds)) leaveChannels(userId, channelIds);
      await voice.enforce(guildId, userIds);
    },
    /** Channels are gone (deleted, or their guild was): empty the rooms. */
    closeChannels: (channelIds: string[]) => {
      for (const id of channelIds) socketsLeave(channelRoom(id), [channelRoom(id)]);
      void voice.closeChannels(channelIds);
    },
    // local: this instance's sockets only; other instances keep theirs
    disconnectAll: () => io.local.disconnectSockets(true),
    close: async () => {
      closing = true;
      await Promise.race([Promise.all(presenceTasks), new Promise((r) => setTimeout(r, DRAIN_MS).unref())]);
      await io.close();
      await Promise.all([pub.quit(), sub.quit()]);
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;

/** Wires realtime into the Fastify lifecycle so `app.close()` leaves no open handles. */
export function registerRealtime(app: FastifyInstance, jwtSecret: string, redisUrl: string, voice: Voice, corsOrigins: string[], limits: Limits) {
  const realtime = createRealtime(app.server, jwtSecret, redisUrl, voice, corsOrigins, limits);
  app.decorate("realtime", realtime);
  app.addHook("preClose", async () => realtime.disconnectAll());
  app.addHook("onClose", async () => {
    await realtime.close();
  });
}
