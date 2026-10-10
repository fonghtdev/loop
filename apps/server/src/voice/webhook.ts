import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError } from "../http.js";
import { channelIdOfRoom, dmIdOfRoom } from "./rooms.js";
import type { RoomEvent } from "./livekit.js";

/** Tells subscribers of a voice channel who is in it now; a joiner is re-checked first (see below). */
async function voiceEvent(app: FastifyInstance, { type, room, userId }: RoomEvent, channelId: string) {
  if (type !== "participant_joined" && type !== "participant_left" && type !== "room_finished") return;
  const channel = await prisma.channel.findFirst({ where: { id: channelId, type: "VOICE" } });
  if (!channel) return;
  // A token issued before a revocation still gets someone in; the join webhook is where that is noticed.
  // `userId` only picks whom to re-check: enforce() recomputes their rights from the database.
  if (type === "participant_joined" && userId) await app.voice.enforce(channel.guildId, [userId]);
  const seats = type === "room_finished" ? [] : await app.livekit.participants(room!);
  app.realtime.emit(channelId, "voice:update", { channelId, participants: seats.map(({ userId, username }) => ({ userId, username })) });
}

/** A DM call is over when its room finishes or the last participant leaves; both may fire, clients treat it as idempotent. */
async function dmEvent(app: FastifyInstance, { type, room }: RoomEvent, dmId: string) {
  if (type !== "participant_left" && type !== "room_finished") return;
  const dm = await prisma.dmChannel.findUnique({ where: { id: dmId } });
  if (!dm) return;
  if (type === "participant_left" && (await app.livekit.participants(room!)).length) return;
  app.realtime.emitToUsers([dm.userLowId, dm.userHighId], "call:ended", { dmChannelId: dm.id });
}

/**
 * LiveKit's webhook. Outside the auth hook: the only credential is LiveKit's signature over the raw body, and
 * nothing in the payload is trusted beyond that. Unknown events and rooms are acknowledged and ignored.
 */
export function webhookRoutes(app: FastifyInstance) {
  app.register(async (hooks) => {
    // LiveKit posts `application/webhook+json`; keep the body as the exact string the signature covers
    hooks.addContentTypeParser("application/webhook+json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    hooks.post("/livekit/webhook", async (req, reply) => {
      const event = await (typeof req.body === "string"
        ? app.livekit.verifyWebhook(req.body, req.headers.authorization)
        : Promise.reject(new Error("body not verifiable"))
      ).catch(() => {
        throw new HttpError(401, "Unauthorized");
      });
      const channelId = event.room && channelIdOfRoom(event.room);
      const dmId = event.room && dmIdOfRoom(event.room);
      if (channelId) await voiceEvent(app, event, channelId);
      else if (dmId) await dmEvent(app, event, dmId);
      return reply.code(200).send({});
    });
  });
}
