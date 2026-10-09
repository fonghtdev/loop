import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { z } from "zod";
import { verifyAccessToken } from "./auth/tokens.js";
import { HttpError } from "./http.js";
import { hiddenChannels, requireChannelPermission } from "./guilds/access.js";
import { friendIds } from "./social/access.js";

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
 * `friend:request` {from}, `friend:accepted` {user}, `friend:removed` {userId}, `presence:update` {userId, online}.
 * Rooms span instances through the Redis adapter.
 */
export type MessageEvent = "message:new" | "message:update" | "message:delete";

const channelRoom = (channelId: string) => `channel:${channelId}`;
const userRoom = (userId: string) => `user:${userId}`;
const subscribeSchema = z.object({ channelId: z.string() });

export function createRealtime(httpServer: HttpServer, jwtSecret: string, redisUrl: string) {
  const pub = new Redis(redisUrl);
  const sub = pub.duplicate();
  const io = new Server(httpServer, { adapter: createAdapter(pub, sub) });

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
  const trackPresence = async (userId: string, up: boolean) => {
    const count = (await io.in(userRoom(userId)).fetchSockets()).length;
    if (count === (up ? 1 : 0)) await announce(userId, up);
  };

  // ponytail: the token is only checked at handshake, so a socket outlives the 15 min access token;
  // ceiling = expiry/revocation latency, upgrade = periodic re-auth or short-lived socket tickets
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const userId = typeof token === "string" ? await verifyAccessToken(token, jwtSecret) : null;
    if (!userId) return next(new Error("Unauthorized"));
    socket.data.userId = userId;
    next();
  });

  io.on("connection", (socket) => {
    const userId: string = socket.data.userId;
    socket.join(userRoom(userId));
    socket.on("disconnect", () => void trackPresence(userId, false).catch(() => {}));

    const handle = (action: "join" | "leave") => async (payload: unknown, ack?: unknown) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
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
    void trackPresence(userId, true).catch(() => {});
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
    emit: (channelId: string, event: MessageEvent, payload: object) => {
      io.to(channelRoom(channelId)).emit(event, payload);
    },
    emitToUsers,
    /** Both participants' user rooms; no subscribe step. */
    emitDm: (dm: { userLowId: string; userHighId: string }, event: "new" | "update" | "delete", payload: object) =>
      emitToUsers([dm.userLowId, dm.userHighId], `dm:message:${event}`, payload),
    onlineIds,
    leaveChannels,
    /**
     * Something may have taken VIEW_CHANNEL away (role/overwrite change, ownership transfer): recompute it for
     * these members (default: all) and drop their sockets from every room they can no longer see.
     * Call after the change commits. A subscribe racing with the change can still slip in before this runs.
     */
    // ponytail: recomputes members x channels per call; fine for small guilds, upgrade = scope to the changed role's holders/channel
    revalidate: async (guildId: string, userIds?: string[]) => {
      for (const { userId, channelIds } of await hiddenChannels(guildId, userIds)) leaveChannels(userId, channelIds);
    },
    /** Channels are gone (deleted, or their guild was): empty the rooms. */
    closeChannels: (channelIds: string[]) => {
      for (const id of channelIds) socketsLeave(channelRoom(id), [channelRoom(id)]);
    },
    // local: this instance's sockets only; other instances keep theirs
    disconnectAll: () => io.local.disconnectSockets(true),
    close: async () => {
      await io.close();
      await Promise.all([pub.quit(), sub.quit()]);
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;

/** Wires realtime into the Fastify lifecycle so `app.close()` leaves no open handles. */
export function registerRealtime(app: FastifyInstance, jwtSecret: string, redisUrl: string) {
  const realtime = createRealtime(app.server, jwtSecret, redisUrl);
  app.decorate("realtime", realtime);
  app.addHook("preClose", async () => realtime.disconnectAll());
  app.addHook("onClose", async () => {
    await realtime.close();
  });
}
