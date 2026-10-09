import type { Server as HttpServer } from "node:http";
import type { FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { z } from "zod";
import { verifyAccessToken } from "./auth/tokens.js";
import { HttpError } from "./http.js";
import { requireChannelMember } from "./guilds/access.js";

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
 */
export type MessageEvent = "message:new" | "message:update" | "message:delete";

const channelRoom = (channelId: string) => `channel:${channelId}`;
const subscribeSchema = z.object({ channelId: z.string() });

// ponytail: single instance only; scaling out needs the Socket.IO Redis adapter (Redis arrives in step 6)
export function createRealtime(httpServer: HttpServer, jwtSecret: string) {
  const io = new Server(httpServer);

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
    socket.join(`user:${userId}`);

    const handle = (action: "join" | "leave") => async (payload: unknown, ack?: unknown) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        const parsed = subscribeSchema.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, error: "Invalid request" });
        const { channelId } = parsed.data;
        if (action === "join") {
          await requireChannelMember(channelId, userId);
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
  });

  return {
    emit: (channelId: string, event: MessageEvent, payload: object) => {
      io.to(channelRoom(channelId)).emit(event, payload);
    },
    /** A user lost access to these channels (left the guild): drop all their sockets from the rooms. */
    leaveChannels: (userId: string, channelIds: string[]) => {
      io.in(`user:${userId}`).socketsLeave(channelIds.map(channelRoom));
    },
    /** Channels are gone (deleted, or their guild was): empty the rooms. */
    closeChannels: (channelIds: string[]) => {
      for (const id of channelIds) io.in(channelRoom(id)).socketsLeave(channelRoom(id));
    },
    disconnectAll: () => io.local.disconnectSockets(true),
    close: () => io.close(),
  };
}

export type Realtime = ReturnType<typeof createRealtime>;

/** Wires realtime into the Fastify lifecycle so `app.close()` leaves no open handles. */
export function registerRealtime(app: FastifyInstance, jwtSecret: string) {
  const realtime = createRealtime(app.server, jwtSecret);
  app.decorate("realtime", realtime);
  app.addHook("preClose", async () => realtime.disconnectAll());
  app.addHook("onClose", async () => {
    await realtime.close();
  });
}
