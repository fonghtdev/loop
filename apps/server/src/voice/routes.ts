import type { FastifyInstance } from "fastify";
import { MAX_VOICE_PARTICIPANTS, Permission } from "@loop/shared";
import { requireChannelPermission } from "../guilds/access.js";
import { HttpError } from "../http.js";
import { requireUser } from "../social/access.js";
import { voiceRights } from "./enforce.js";
import { joinRoom } from "./join.js";
import { voiceRoom } from "./rooms.js";

const VOICE_TIMEOUTS = { emptyTimeout: 300, departureTimeout: 20 };
const notVoice = () => new HttpError(400, "Not a voice channel");

export function voiceRoutes(app: FastifyInstance) {
  /** Join token for a voice channel: CONNECT (404 when the channel is hidden, 403 when visible without it). */
  app.post<{ Params: { channelId: string } }>("/channels/:channelId/voice/token", async (req) => {
    const { channel, perms } = await requireChannelPermission(req.params.channelId, req.userId, Permission.CONNECT);
    if (channel.type !== "VOICE") throw notVoice();
    const { body } = await joinRoom(app, await requireUser({ id: req.userId }), voiceRoom(channel.id), {
      max: MAX_VOICE_PARTICIPANTS,
      rights: voiceRights(perms),
      timeouts: VOICE_TIMEOUTS,
    });
    return body;
  });

  /** Who is in the channel right now, straight from LiveKit; anyone who can see the channel may ask. */
  app.get<{ Params: { channelId: string } }>("/channels/:channelId/voice", async (req) => {
    const { channel } = await requireChannelPermission(req.params.channelId, req.userId);
    if (channel.type !== "VOICE") throw notVoice();
    const seats = await app.livekit.participants(voiceRoom(channel.id));
    return { participants: seats.map(({ userId, username }) => ({ userId, username })) };
  });
}
