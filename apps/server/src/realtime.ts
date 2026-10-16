import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { z } from "zod";
import { verifyAccessToken } from "./auth/tokens.js";
import { HttpError } from "./http.js";
import { hasPermission, Permission, type PresenceStatus, presenceAwaySchema, type StatusPref, type TypingEvent, typingSchema } from "@loop/shared";
import { prisma } from "./db.js";
import { hiddenChannels, memberChannelPermissions, requireChannelPermission, requireWritableChannel } from "./guilds/access.js";
import type { Limits } from "./limiter.js";
import { effectiveStatus, presenceFields } from "./presence.js";
import { blockedWith, presenceAudience, requireDmWritable } from "./social/access.js";
import type { Voice } from "./voice/enforce.js";

declare module "fastify" {
  interface FastifyInstance {
    realtime: Realtime;
  }
}

/**
 * Socket.IO is only a push channel: writes and history go through REST.
 * Client -> server: `channel:subscribe` / `channel:unsubscribe` {channelId}, acked {ok:true} | {ok:false,error};
 * `presence:away` {away: boolean} (no ack; anything else is ignored); `typing` {channelId} | {dmChannelId} (no ack; dropped unless the
 * sender could post there, at most one per 2 s per socket).
 * `typing` {channelId|dmChannelId, userId, at(ms)} goes to the channel room (never to the sender's own rooms) or the other DM participants' rooms.
 * `read:updated` {channelId|dmChannelId, lastReadSeq} goes to the reader's own user room when a read pointer moves forward.
 * Server -> room `channel:<id>`: `message:new` | `message:update` (message JSON as in REST), `message:delete` {id, channelId}.
 * `message:pin` {messageId, channelId, pinned} goes to the same room. The sender receives its own events too; clients dedupe by message id.
 * User rooms `user:<id>` (every authenticated socket joins its own) carry DM, friend and presence events:
 * `dm:message:new|update` (message JSON), `dm:message:delete` {id, dmChannelId}, `dm:message:pin` {messageId, dmChannelId, pinned} (to every participant),
 * `dm:new` {id, user} (pair) | group DM JSON (to whoever was added), `dm:updated` group DM JSON (to every current participant),
 * `dm:removed` {dmChannelId} (to whoever left or was removed),
 * `friend:request` {from}, `friend:accepted` {user}, `friend:removed` {userId},
 * `presence:update` {userId, online, status} (to friends + guild co-members, never across a block; `online` = status !== "offline"),
 * `me:status` {status} (the user's own preference, so their other devices follow),
 * `call:incoming` {dmChannelId, from, video}, `call:declined` {dmChannelId, by}, `call:ended` {dmChannelId},
 * `voice:moved` {channelId, by:{id,username}} (only the moved member: rejoin that voice channel).
 * Guild layout events go to the members' `user:<id>` rooms: `channel:created` (channel JSON), `category:created|updated`
 * (category JSON), `category:deleted`, `layout:updated` (payloads in packages/shared); channel data is filtered per member by VIEW_CHANNEL.
 * `user:updated` {id, username, displayName, avatarHash, bannerHash, statusText} goes to the presence audience + the user (profile or image changed);
 * `guild:updated` {id, name, iconHash} to every member; `channel:updated` (channel JSON) to members who can VIEW it.
 * `mention:new` {guildId, channelId, message} goes to the mentioned people (every member who can VIEW the channel for @everyone / @here), never the author,
 * so a channel they have not subscribed to still reaches them.
 * `member:joined` {guildId, user:{id,username,isBot}} goes to every member (the newcomer included) when someone joins by invite.
 * Threads are channels (room `channel:<threadId>`, same message events, permissions from the parent): `thread:created` |
 * `thread:updated` (thread JSON) and `thread:deleted` {id, guildId, parentChannelId, starterMessageId} go to the user room of
 * every member who can VIEW the parent; `mention:new` carries `parentChannelId` (null outside a thread).
 * Rooms span instances through the Redis adapter.
 */
export type MessageEvent = "message:new" | "message:update" | "message:delete" | "message:reaction" | "message:pin";
/**
 * Also pushed to room `channel:<id>` of a voice channel: `voice:update` {channelId, participants:[{userId, username}]};
 * and to a text channel's room when one of its threads got or lost a message: `thread:updated` (thread JSON).
 */
export type ChannelEvent = MessageEvent | "voice:update" | "thread:updated";

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

  type Flag = { id: string; away: boolean };
  const flagsOf = (sockets: { id: string; data: { away?: unknown } }[]): Flag[] => sockets.map((s) => ({ id: s.id, away: s.data.away === true }));
  const prefsOf = async (userIds: string[]) =>
    new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, statusPref: true } })).map((u) => [u.id, u.statusPref as StatusPref]));

  /**
   * Each user's status as `viewerId` may see it, from the adapter (sockets on every instance, nothing to go stale
   * after a crash) and the stored preference: invisible -> offline, a block in either direction -> offline.
   */
  const statusOf = async (viewerId: string, userIds: string[]) => {
    const out = new Map<string, PresenceStatus>();
    if (!userIds.length) return out;
    const [sockets, prefs, blocked] = await Promise.all([io.in(userIds.map(userRoom)).fetchSockets(), prefsOf(userIds), blockedWith(viewerId)]);
    const away = new Map<string, boolean[]>();
    for (const s of sockets) away.set(s.data.userId, [...(away.get(s.data.userId) ?? []), s.data.away === true]);
    for (const id of userIds) out.set(id, blocked.has(id) ? "offline" : effectiveStatus(prefs.get(id) ?? "invisible", away.get(id) ?? []));
    return out;
  };

  // ponytail: presence is recomputed from the adapter on each transition (socket up/down, away flip, preference
  // change) by comparing the status before and after it; nothing is stored but the preference. Two transitions of
  // one user on different instances in the same instant can both compute from the same snapshot and send nothing
  // (or twice), and a crashed instance sends no offline; lists always recompute, so the ceiling is a stale live
  // status until the next fetch. Upgrade = a TTL'd presence key in Redis with heartbeats. Best effort: failures are swallowed.
  // Presence work talks to Redis through the adapter, so `close` must let it finish before quitting the clients
  // (a command queued on a closing connection rejects inside the adapter, where nobody can catch it).
  // ponytail: the wait is capped at 1 s because a peer that is closing too never answers `fetchSockets` (the
  // adapter would wait its full 5 s); a request still pending after the cap only ends by its own timeout, which
  // our `.catch` swallows. Ceiling = a peer that stalls mid-shutdown; upgrade = a shorter `requestsTimeout`.
  const DRAIN_MS = 1000;
  let closing = false;
  const presenceTasks = new Set<Promise<void>>();
  const queues = new Map<string, Promise<void>>();
  /**
   * Presence work of one user runs in order on this instance, so each step sees the effect of the previous one
   * (a flag set by an earlier `presence:away` is never read by the connect that came before it).
   */
  const enqueue = <T>(userId: string, work: () => Promise<T>) => {
    const run = (queues.get(userId) ?? Promise.resolve()).then(work);
    const task = run.then(() => {}, () => {});
    queues.set(userId, task);
    presenceTasks.add(task);
    void task.then(() => {
      presenceTasks.delete(task);
      if (queues.get(userId) === task) queues.delete(userId);
    });
    return run;
  };
  /**
   * Pushes `presence:update` when the user's status changed: `before` rebuilds the socket flags as they were from
   * the current ones, `oldPref` is the preference before the change (default: unchanged).
   */
  const announceChange = async (userId: string, before: (now: Flag[]) => Flag[], oldPref?: StatusPref) => {
    const [sockets, prefs] = await Promise.all([io.in(userRoom(userId)).fetchSockets(), prefsOf([userId])]);
    const pref = prefs.get(userId);
    if (!pref) return;
    const now = flagsOf(sockets);
    const status = effectiveStatus(pref, now.map((f) => f.away));
    if (effectiveStatus(oldPref ?? pref, before(now).map((f) => f.away)) === status) return;
    emitToUsers(await presenceAudience(userId), "presence:update", { userId, ...presenceFields(status) });
  };
  const trackPresence = (userId: string, before: (now: Flag[]) => Flag[], oldPref?: StatusPref) => {
    if (!closing) enqueue(userId, () => announceChange(userId, before, oldPref)).catch(() => {});
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
    socket.data.away = false;
    socket.join(userRoom(userId));
    const without = (now: Flag[]) => now.filter((f) => f.id !== socket.id);
    socket.on("disconnect", () => trackPresence(userId, (now) => [...without(now), { id: socket.id, away: socket.data.away === true }]));

    // ponytail: per socket and in memory; reconnecting resets them, but connects are limited per IP
    const subscribeAllowed = limits.socketBudget("socket-subscribe");
    const presenceAllowed = limits.socketBudget("socket-presence");
    const typingAllowed = limits.socketBudget("socket-typing");
    let away = false; // the latest flag asked for; socket.data.away follows it in queue order
    socket.on("presence:away", (payload: unknown) => {
      const parsed = presenceAwaySchema.safeParse(payload);
      if (closing || !parsed.success || parsed.data.away === away) return;
      const flag = (away = parsed.data.away);
      const live = presenceAllowed(); // over budget the flag is still kept (lists stay right), only the push is dropped
      enqueue(userId, async () => {
        socket.data.away = flag;
        if (live) await announceChange(userId, (now) => now.map((f) => (f.id === socket.id ? { ...f, away: !flag } : f)));
      }).catch(() => {});
    });
    // Relays "is typing" to whoever could read a message from this user; nothing is stored and failures are silent.
    socket.on("typing", async (payload: unknown) => {
      const parsed = typingSchema.safeParse(payload);
      if (closing || !parsed.success || !typingAllowed()) return;
      try {
        const at = Date.now();
        if ("channelId" in parsed.data) {
          const { channelId } = parsed.data;
          await requireWritableChannel(channelId, userId);
          io.to(channelRoom(channelId)).except(userRoom(userId)).emit("typing", { channelId, userId, at } satisfies TypingEvent);
        } else {
          const { dmChannelId } = parsed.data;
          const { otherIds } = await requireDmWritable(dmChannelId, userId);
          emitToUsers(otherIds, "typing", { dmChannelId, userId, at } satisfies TypingEvent);
        }
      } catch {
        // not allowed to write there (or gone): drop
      }
    });
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
    trackPresence(userId, without);
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
    /**
     * Guild-level event to every member's user room (members do not join a guild room). `payload` builds each
     * member's copy from `canSee(channelId)` (VIEW_CHANNEL) so hidden channels never leak; null = skip that member.
     */
    emitToGuild: async (guildId: string, event: string, payload: (canSee: (channelId: string) => boolean) => object | null) => {
      for (const { userId, perms } of await memberChannelPermissions(guildId)) {
        const body = payload((id) => hasPermission(perms.get(id) ?? 0, Permission.VIEW_CHANNEL));
        if (body) emitToUsers([userId], event, body);
      }
    },
    /** Liveness probe of the shared Redis connection (used by GET /health). */
    ping: () => pub.ping(),
    /** Every current participant's user room (pair or group); no subscribe step. Pass the ids read with the access check. */
    emitDm: (participantIds: string[], event: "new" | "update" | "delete" | "reaction" | "pin", payload: object) =>
      emitToUsers(participantIds, `dm:message:${event}`, payload),
    statusOf,
    /**
     * Stores the user's preference in their presence queue (so presence work queued before it still sees the old
     * one), then pushes the new status if it differs. Resolves once stored; the push is best effort.
     */
    setStatus: (userId: string, pref: StatusPref) => {
      const write = enqueue(userId, async () => {
        const old = (await prefsOf([userId])).get(userId);
        await prisma.user.update({ where: { id: userId }, data: { statusPref: pref } });
        return old;
      });
      // Queued right behind the write, so nothing can run between the two.
      enqueue(userId, async () => !closing && announceChange(userId, (now) => now, await write)).catch(() => {});
      return write;
    },
    /** Sockets out of the channel rooms, and the user out of any voice room among them. */
    leaveChannels: (userId: string, channelIds: string[]) => {
      leaveChannels(userId, channelIds);
      void voice.removeUser(userId, channelIds);
    },
    /**
     * Something may have taken VIEW_CHANNEL away (role/overwrite change, ownership transfer): recompute it for
     * these members (default: all) and drop their sockets from every room they can no longer see.
     * Voice sessions are re-checked the same way (CONNECT, SPEAK, VIDEO, STREAM too): removed or downgraded in LiveKit.
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
    /** Every socket of the user on every instance (its credentials were revoked); local ones before this returns. */
    disconnectUser: (userId: string) => {
      io.local.in(userRoom(userId)).disconnectSockets(true);
      io.in(userRoom(userId)).disconnectSockets(true);
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
