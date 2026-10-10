import type { FastifyInstance } from "fastify";
import { HttpError } from "../http.js";
import { TOKEN_TTL_SECONDS, type Rights } from "./livekit.js";

/**
 * Creates the room if needed and issues a join token. 409 when the room has no free seat for this user (the
 * check is best effort, LiveKit's own max is the hard limit). `empty` = nobody was in the room yet.
 */
export async function joinRoom(
  app: FastifyInstance,
  user: { id: string; username: string },
  room: string,
  { max, rights, timeouts }: { max: number; rights: Rights; timeouts: { emptyTimeout: number; departureTimeout: number } },
) {
  const info = await app.livekit.ensureRoom(room, max, timeouts);
  const seats = await app.livekit.participants(room);
  if (info.maxParticipants > 0 && seats.length >= info.maxParticipants && !seats.some((s) => s.userId === user.id)) {
    throw new HttpError(409, "Channel is full");
  }
  return {
    empty: seats.length === 0,
    body: {
      token: await app.livekit.token(room, user, rights),
      url: app.livekit.url,
      room,
      expiresInSeconds: TOKEN_TTL_SECONDS,
      canSpeak: rights.speak,
      canVideo: rights.video,
    },
  };
}
