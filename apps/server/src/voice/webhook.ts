import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError } from "../http.js";
import { channelIdOfRoom, dmIdOfRoom } from "./rooms.js";
import type { RoomEvent } from "./livekit.js";
import { seatDtos } from "./enforce.js";

/** Tells subscribers of a voice channel who is in it now; a joiner is re-checked first (see below). */
async function voiceEvent(app: FastifyInstance, { type, room, userId, screenShare }: RoomEvent, channelId: string) {
  const trackChange = (type === "track_published" || type === "track_unpublished") && screenShare; // mic/camera changes are not shown
  if (type !== "participant_joined" && type !== "participant_left" && type !== "room_finished" && !trackChange) return;
  const channel = await prisma.channel.findFirst({ where: { id: channelId, type: "VOICE" } });
  if (!channel) return;
  // A token issued before a revocation still gets someone in; the join webhook is where that is noticed.
  // `userId` only picks whom to re-check: enforce() recomputes their rights from the database.
  if (type === "participant_joined" && userId) await app.voice.enforce(channel.guildId, [userId]);
  const seats = type === "room_finished" ? [] : await app.livekit.participants(room!);
  app.realtime.emit(channelId, "voice:update", { channelId, participants: await seatDtos(channel.guildId, seats) });
}

/**
 * A DM call is over when its room finishes or the last participant leaves; both may fire, clients treat it as
 * idempotent. A joiner who is no longer a participant (left / removed from a group with a still valid token) is put out.
 */
async function dmEvent(app: FastifyInstance, { type, room, userId }: RoomEvent, dmId: string) {
  if (type === "participant_joined" && userId) {
    if (!(await prisma.dmParticipant.count({ where: { dmChannelId: dmId, userId } }))) {
      await app.livekit.removeParticipant(room!, userId).catch((e) => app.log.error({ err: String((e as Error)?.message) }, "voice remove failed"));
    }
    return;
  }
  if (type !== "participant_left" && type !== "room_finished") return;
  const participants = (await prisma.dmParticipant.findMany({ where: { dmChannelId: dmId }, select: { userId: true } })).map((p) => p.userId);
  if (!participants.length) return;
  if (type === "participant_left" && (await app.livekit.participants(room!)).length) return;
  app.realtime.emitToUsers(participants, "call:ended", { dmChannelId: dmId });
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
