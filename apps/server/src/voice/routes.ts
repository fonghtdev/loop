import type { FastifyInstance } from "fastify";
import { hasPermission, MAX_VOICE_PARTICIPANTS, Permission, type VoiceModeratedEvent, voiceStateSchema } from "@loop/shared";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { memberChannelPermissions, NOT_FOUND, requireChannelPermission, requireManageableMember } from "../guilds/access.js";
import { HttpError, parse } from "../http.js";
import { requireUser } from "../social/access.js";
import { seatDtos, voiceRights } from "./enforce.js";
import { joinRoom } from "./join.js";
import { voiceRoom } from "./rooms.js";

const VOICE_TIMEOUTS = { emptyTimeout: 300, departureTimeout: 20 };
const notVoice = () => new HttpError(400, "Not a voice channel");
const moveBody = z.object({ userId: z.string().uuid() });

export function voiceRoutes(app: FastifyInstance) {
  /** Join token for a voice channel: CONNECT (404 when the channel is hidden, 403 when visible without it). */
  app.post<{ Params: { channelId: string } }>("/channels/:channelId/voice/token", async (req) => {
    const { channel, perms } = await requireChannelPermission(req.params.channelId, req.userId, Permission.CONNECT);
    if (channel.type !== "VOICE") throw notVoice();
    // a server mute / deafen holds across rejoins: the token never grants what the moderation state takes away
    const mod = await prisma.voiceModState.findUnique({ where: { guildId_userId: { guildId: channel.guildId, userId: req.userId } } });
    const { body } = await joinRoom(app, await requireUser({ id: req.userId }), voiceRoom(channel.id), {
      max: MAX_VOICE_PARTICIPANTS,
      rights: voiceRights(perms, mod),
      timeouts: VOICE_TIMEOUTS,
    });
    return { ...body, serverMuted: !!mod?.serverMute, serverDeafened: !!mod?.serverDeafen };
  });

  /** Who is in the channel right now, straight from LiveKit; anyone who can see the channel may ask. */
  app.get<{ Params: { channelId: string } }>("/channels/:channelId/voice", async (req) => {
    const { channel } = await requireChannelPermission(req.params.channelId, req.userId);
    if (channel.type !== "VOICE") throw notVoice();
    const seats = await app.livekit.participants(voiceRoom(channel.id));
    return { participants: await seatDtos(channel.guildId, seats) };
  });

  /**
   * Server mute / deafen of a member who sits in this voice channel. `mute` needs MUTE_MEMBERS, `deafen` DEAFEN_MEMBERS,
   * in this channel (both bits are channel-overwritable). Target: the kick rule (not the owner, not yourself: 400, top
   * role strictly below the caller's unless the caller owns the guild). The state is stored (VoiceModState) so a rejoin
   * cannot shed it; it lasts until a moderator lifts it or the membership goes (leaving voice does NOT clear it).
   * 404 hidden channel / foreign member, 403 missing bit / rank, 400 not VOICE / body / self, 409 not in this room.
   */
  app.put<{ Params: { channelId: string; userId: string } }>("/channels/:channelId/voice/members/:userId/state", async (req, reply) => {
    const { channel, access, perms } = await requireChannelPermission(req.params.channelId, req.userId);
    if (channel.type !== "VOICE") throw notVoice();
    const body = parse(voiceStateSchema, req.body, reply);
    if (!body) return;
    if (body.mute !== undefined && !hasPermission(perms, Permission.MUTE_MEMBERS)) throw new HttpError(403, "Missing permission");
    if (body.deafen !== undefined && !hasPermission(perms, Permission.DEAFEN_MEMBERS)) throw new HttpError(403, "Missing permission");
    const { userId } = req.params;
    await requireManageableMember(access, userId, false);
    if (!(await app.livekit.participants(voiceRoom(channel.id))).some((s) => s.userId === userId)) throw new HttpError(409, "Member is not in this voice channel");

    const key = { guildId: channel.guildId, userId };
    const old = await prisma.voiceModState.findUnique({ where: { guildId_userId: key } });
    const was = { serverMute: !!old?.serverMute, serverDeafen: !!old?.serverDeafen };
    const next = { serverMute: body.mute ?? was.serverMute, serverDeafen: body.deafen ?? was.serverDeafen };
    if (next.serverMute === was.serverMute && next.serverDeafen === was.serverDeafen) return reply.code(204).send();
    if (!next.serverMute && !next.serverDeafen) await prisma.voiceModState.deleteMany({ where: key });
    else {
      try {
        await prisma.voiceModState.upsert({ where: { guildId_userId: key }, create: { ...key, ...next, setById: req.userId }, update: { ...next, setById: req.userId } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") throw NOT_FOUND; // left the guild meanwhile
        throw e;
      }
    }
    await app.voice.enforce(channel.guildId, [userId]); // the one place live rights are recomputed (bits minus this state)

    const where = { targetUserId: userId, targetId: channel.id, meta: { channel: channel.name } };
    if (next.serverMute !== was.serverMute) await app.audit(channel.guildId, req.userId, next.serverMute ? "voice.mute" : "voice.unmute", where);
    if (next.serverDeafen !== was.serverDeafen) await app.audit(channel.guildId, req.userId, next.serverDeafen ? "voice.deafen" : "voice.undeafen", where);
    const by = await requireUser({ id: req.userId });
    app.realtime.emitToUsers([userId], "voice:moderated", { channelId: channel.id, ...next, by: { id: by.id, username: by.username } } satisfies VoiceModeratedEvent);
    const seats = await app.livekit.participants(voiceRoom(channel.id));
    app.realtime.emit(channel.id, "voice:update", { channelId: channel.id, participants: await seatDtos(channel.guildId, seats) });
    return reply.code(204).send();
  });

  /**
   * Move a member to this (destination) voice channel: the caller needs MOVE_MEMBERS in the destination AND in
   * the channel the member sits in; the member needs CONNECT in the destination. The server never touches
   * LiveKit: it only tells the member's client (`voice:moved`), which rejoins; the usual webhooks update the lists.
   * 404 hidden destination / foreign member, 403 missing right, 400 not VOICE, 409 member not in voice / already
   * there / destination full. Moving yourself works the same (a switch).
   */
  app.post<{ Params: { channelId: string } }>("/channels/:channelId/voice/move", async (req, reply) => {
    const { channel: dest, access } = await requireChannelPermission(req.params.channelId, req.userId, Permission.MOVE_MEMBERS);
    if (dest.type !== "VOICE") throw notVoice();
    const body = parse(moveBody, req.body, reply);
    if (!body) return;
    const targetId = body.userId;
    const member = await prisma.member.findUnique({ where: { guildId_userId: { guildId: dest.guildId, userId: targetId } } });
    if (!member) throw NOT_FOUND;

    const voiceChannels = await prisma.channel.findMany({ where: { guildId: dest.guildId, type: "VOICE" }, select: { id: true } });
    const rooms = await Promise.all(voiceChannels.map(async (c) => ({ id: c.id, seats: await app.livekit.participants(voiceRoom(c.id)) })));
    const source = rooms.find((r) => r.seats.some((s) => s.userId === targetId));
    if (!source) throw new HttpError(409, "Member is not in a voice channel");
    await requireChannelPermission(source.id, req.userId, Permission.MOVE_MEMBERS);
    if (source.id === dest.id) throw new HttpError(409, "Member is already in that channel");

    const [targetPerms] = await memberChannelPermissions(dest.guildId, [targetId]);
    if (!hasPermission(targetPerms?.perms.get(dest.id) ?? 0, Permission.CONNECT)) throw new HttpError(403, "Member cannot join that channel");
    const [info] = await app.livekit.listRooms([voiceRoom(dest.id)]);
    if (rooms.find((r) => r.id === dest.id)!.seats.length >= (info?.maxParticipants || MAX_VOICE_PARTICIPANTS)) throw new HttpError(409, "Channel is full");

    const by = await requireUser({ id: access.userId });
    await app.audit(dest.guildId, access.userId, "voice.move", { targetUserId: targetId, targetId: dest.id, meta: { channel: dest.name } });
    app.realtime.emitToUsers([targetId], "voice:moved", { channelId: dest.id, by: { id: by.id, username: by.username } });
    return reply.code(204).send();
  });
}
