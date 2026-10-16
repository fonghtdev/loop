import type { FastifyInstance } from "fastify";
import { banSchema, type BanDto, Permission } from "@loop/shared";
import { removeObjects } from "../attachments/sweep.js";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { announceThreadActivity } from "../messages/threads.js";
import { isUuid, NOT_FOUND, requireBannable, requireGuildPermission } from "./access.js";
import { channelIdsOf, lockGuild } from "./routes.js";

type Params = { guildId: string; userId: string };

/** Deleted messages announced one by one (`message:delete`); past this the rest go silently (clients refetch on reconnect). */
export const BAN_ANNOUNCE_MAX = 500;
const HOUR_MS = 60 * 60 * 1000;
const banMembers = (guildId: string, userId: string) => requireGuildPermission(guildId, userId, Permission.BAN_MEMBERS);

/**
 * One transaction under the guild lock (so it cannot interleave with a join, a transfer or another ban): the
 * membership goes like a kick (its roles and member overwrites cascade), the ban row is written, and the user's
 * messages in this guild's channels and threads since `since` are deleted (attachments, reactions, mentions cascade).
 */
const ban = (app: FastifyInstance, guildId: string, userId: string, bannedById: string, body: { reason: string | null; deleteMessageHours: number }, since: Date | null) =>
  prisma.$transaction(async (tx) => {
    const { reason } = body;
    await lockGuild(tx, guildId);
    const guild = await tx.guild.findUnique({ where: { id: guildId } });
    if (!guild) throw NOT_FOUND;
    if (guild.ownerId === userId) throw new HttpError(403, "The owner cannot be managed by others"); // re-read: a transfer may have raced
    const { count } = await tx.member.deleteMany({ where: { guildId, userId } });
    const key = { guildId, userId };
    await tx.guildBan.upsert({ where: { guildId_userId: key }, create: { ...key, bannedById, reason }, update: { bannedById, reason } });
    // ponytail: every matching message is read in one go; a week of heavy spam is a big query, batch it if that bites
    const messages = since
      ? await tx.message.findMany({
          where: { authorId: userId, createdAt: { gte: since }, channel: { guildId } },
          select: { id: true, channelId: true, attachments: { select: { id: true } }, embeds: { select: { thumbHash: true } } },
          orderBy: { seq: "desc" },
        })
      : [];
    if (messages.length) await tx.message.deleteMany({ where: { id: { in: messages.map((m) => m.id) } } });
    await app.audit(guildId, bannedById, "member.ban", { targetUserId: userId, meta: { ...body, deletedMessages: messages.length }, tx });
    return { wasMember: count > 0, messages };
  });

export function banRoutes(app: FastifyInstance) {
  app.get<{ Params: Params }>("/guilds/:guildId/bans", async (req) => {
    const { guild } = await banMembers(req.params.guildId, req.userId);
    const rows = await prisma.guildBan.findMany({
      where: { guildId: guild.id },
      orderBy: { createdAt: "desc" },
      include: { user: { select: { id: true, username: true, displayName: true, avatarHash: true } }, bannedBy: { select: { id: true, username: true } } },
    });
    const bans = rows.map(({ user, reason, bannedBy, createdAt }) => ({ user, reason, bannedBy, createdAt: createdAt.toISOString() }) satisfies BanDto);
    return { bans };
  });

  /** Ban a member (removed like a kick) or anyone else by id. Same hierarchy as kick; ADMINISTRATOR passes the bit only. */
  app.put<{ Params: Params }>("/guilds/:guildId/bans/:userId", async (req, reply) => {
    const access = await banMembers(req.params.guildId, req.userId);
    const body = parse(banSchema, req.body ?? {}, reply);
    if (!body) return;
    const { userId } = req.params;
    await requireBannable(access, userId);
    const guildId = access.guild.id;
    const since = body.deleteMessageHours ? new Date(Date.now() - body.deleteMessageHours * HOUR_MS) : null;
    const { wasMember, messages } = await ban(app, guildId, userId, req.userId, body, since);
    if (wasMember) app.realtime.leaveChannels(userId, await channelIdsOf(guildId)); // sockets and voice, as a kick
    await removeObjects(app.storage, messages.flatMap((m) => m.attachments.map((a) => a.id)));
    await app.embeds.removeThumbs(messages.flatMap((m) => m.embeds.map((e) => e.thumbHash)));
    for (const m of messages.slice(0, BAN_ANNOUNCE_MAX)) app.realtime.emit(m.channelId!, "message:delete", { id: m.id, channelId: m.channelId });
    const touched = [...new Set(messages.map((m) => m.channelId!))];
    const threads = touched.length ? await prisma.channel.findMany({ where: { id: { in: touched }, parentChannelId: { not: null } }, select: { id: true } }) : [];
    for (const t of threads) await announceThreadActivity(app, t.id);
    return reply.code(204).send();
  });

  /** Unban (idempotent). No hierarchy: the user is not a member, so they have no rank to compare. */
  app.delete<{ Params: Params }>("/guilds/:guildId/bans/:userId", async (req, reply) => {
    const { guild } = await banMembers(req.params.guildId, req.userId);
    if (!isUuid(req.params.userId)) throw NOT_FOUND;
    const { count } = await prisma.guildBan.deleteMany({ where: { guildId: guild.id, userId: req.params.userId } });
    if (count) await app.audit(guild.id, req.userId, "member.unban", { targetUserId: req.params.userId });
    return reply.code(204).send();
  });
}
