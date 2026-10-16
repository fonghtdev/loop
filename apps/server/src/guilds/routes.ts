import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  createChannelSchema,
  DEFAULT_CATEGORIES,
  createGuildSchema,
  DEFAULT_EVERYONE_PERMISSIONS,
  hasPermission,
  Permission,
  transferOwnershipSchema,
  updateChannelSchema,
  updateGuildSchema,
} from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import {
  bitsInChannel,
  NOT_FOUND,
  requireGuildChannel,
  requireGuildPermission,
  requireManageableMember,
  requireMember,
  requireOwner,
} from "./access.js";

type Params = { guildId: string; channelId: string; userId: string };

export const channelIdsOf = async (guildId: string) =>
  (await prisma.channel.findMany({ where: { guildId }, select: { id: true } })).map((c) => c.id);

// Serializes per-guild writes that read-then-write (channel/role positions, "keep one channel", ownership).
export const lockGuild = (tx: Prisma.TransactionClient, guildId: string) =>
  tx.$queryRaw`SELECT id FROM "Guild" WHERE id = ${guildId}::uuid FOR UPDATE`;

/**
 * Removes a member unless they own the guild; locked so it cannot interleave with an ownership transfer.
 * `then` runs in the same transaction once a member was really removed (a kick's audit entry).
 */
const removeMember = (guildId: string, userId: string, then?: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
  prisma.$transaction(async (tx) => {
    await lockGuild(tx, guildId);
    const guild = await tx.guild.findUnique({ where: { id: guildId } });
    if (!guild) throw NOT_FOUND;
    if (guild.ownerId === userId) return false;
    if ((await tx.member.deleteMany({ where: { guildId, userId } })).count) await then?.(tx);
    return true;
  });

/** `guild:updated` {id, name, iconHash} to every member's user room. */
export async function announceGuild(app: FastifyInstance, guildId: string) {
  const { id, name, iconHash } = await prisma.guild.findUniqueOrThrow({ where: { id: guildId } });
  await app.realtime.emitToGuild(guildId, "guild:updated", () => ({ id, name, iconHash }));
}

// ponytail: no cap on guilds per user or channels per guild; add limits before public launch
export function guildRoutes(app: FastifyInstance) {
  app.post("/guilds", async (req, reply) => {
    const body = parse(createGuildSchema, req.body, reply);
    if (!body) return;
    const id = randomUUID(); // @everyone shares the guild's id
    const textCategoryId = randomUUID();
    const { channels, categories, ...rest } = await prisma.$transaction(async (tx) => {
      const guild = await tx.guild.create({
        data: {
          id,
          name: body.name,
          ownerId: req.userId,
          roles: { create: { id, name: "@everyone", permissions: DEFAULT_EVERYONE_PERMISSIONS, position: 0 } },
          members: { create: { userId: req.userId } },
          categories: {
            create: [
              { id: textCategoryId, name: DEFAULT_CATEGORIES.TEXT, position: 0 },
              { name: DEFAULT_CATEGORIES.VOICE, position: 1 },
            ],
          },
        },
        include: { categories: { orderBy: { position: "asc" } } },
      });
      const general = await tx.channel.create({
        data: { guildId: id, categoryId: textCategoryId, name: "general", type: "TEXT", position: 0 },
      });
      return { ...guild, channels: [general] };
    });
    return reply.code(201).send({ guild: rest, channels, categories });
  });

  app.get("/guilds", async (req) =>
    prisma.guild.findMany({
      where: { members: { some: { userId: req.userId } } },
      orderBy: { createdAt: "asc" },
    }),
  );

  /** Channels come with their role and member overwrites (so the client can run `computePermissions`); hidden ones are left out. */
  app.get<{ Params: Params }>("/guilds/:guildId", async (req) => {
    const access = await requireMember(req.params.guildId, req.userId);
    const channels = await prisma.channel.findMany({
      where: { guildId: access.guild.id, parentChannelId: null }, // threads are listed per channel (GET /channels/:id/threads)
      // positions are per category (not unique across the guild): break ties the same way as `byPlacement` in categories.ts
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      include: {
        overwrites: { select: { roleId: true, allow: true, deny: true } },
        memberOverwrites: { select: { userId: true, allow: true, deny: true } },
      },
    });
    const visible = channels.filter((c) => hasPermission(bitsInChannel(access, c), Permission.VIEW_CHANNEL));
    const categories = await prisma.category.findMany({ where: { guildId: access.guild.id }, orderBy: { position: "asc" } });
    return { guild: access.guild, channels: visible, categories };
  });

  /** Rename: the owner or an administrator. */
  app.patch<{ Params: Params }>("/guilds/:guildId", async (req, reply) => {
    const { guild } = await requireGuildPermission(req.params.guildId, req.userId, Permission.ADMINISTRATOR);
    const body = parse(updateGuildSchema, req.body, reply);
    if (!body) return;
    const updated = await prisma.guild.update({ where: { id: guild.id }, data: body });
    if (body.name !== undefined) await app.audit(guild.id, req.userId, "guild.update", { meta: { name: updated.name } });
    await announceGuild(app, guild.id);
    return updated;
  });

  app.delete<{ Params: Params }>("/guilds/:guildId", async (req, reply) => {
    const { guild } = await requireOwner(req.params.guildId, req.userId);
    const channelIds = await channelIdsOf(guild.id);
    // conditional on ownership so a concurrent transfer cannot let the old owner delete it
    const { count } = await prisma.guild.deleteMany({ where: { id: guild.id, ownerId: req.userId } });
    if (count === 0) throw new HttpError(403, "Only the owner can do this");
    app.realtime.closeChannels(channelIds);
    return reply.code(204).send();
  });

  app.post<{ Params: Params }>("/guilds/:guildId/channels", async (req, reply) => {
    const { guild } = await requireGuildPermission(req.params.guildId, req.userId, Permission.MANAGE_CHANNELS);
    const body = parse(createChannelSchema, req.body, reply);
    if (!body) return;
    try {
      const channel = await prisma.$transaction(async (tx) => {
        await lockGuild(tx, guild.id);
        const categoryId = body.categoryId ?? null;
        if (categoryId && !(await tx.category.findFirst({ where: { id: categoryId, guildId: guild.id } }))) {
          throw new HttpError(400, "Unknown category");
        }
        // position is per category (or per the uncategorised area): the new channel goes last
        const last = await tx.channel.aggregate({ where: { guildId: guild.id, categoryId }, _max: { position: true } });
        const created = await tx.channel.create({
          data: { guildId: guild.id, ...body, categoryId, position: (last._max.position ?? -1) + 1 },
        });
        await app.audit(guild.id, req.userId, "channel.create", { targetId: created.id, meta: { name: created.name, type: body.type }, tx });
        return created;
      });
      await app.realtime.emitToGuild(guild.id, "channel:created", (canSee) => (canSee(channel.id) ? channel : null));
      return reply.code(201).send(channel);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new HttpError(409, "Channel name already taken");
      }
      throw e;
    }
  });

  /** Rename and topic. A visible channel without MANAGE_CHANNELS is a 403, a hidden one a 404. */
  app.patch<{ Params: Pick<Params, "channelId"> }>("/channels/:channelId", async (req, reply) => {
    const { channel } = await requireGuildChannel(req.params.channelId, req.userId, Permission.MANAGE_CHANNELS);
    const body = parse(updateChannelSchema, req.body, reply);
    if (!body) return;
    try {
      const updated = await prisma.channel.update({ where: { id: channel.id }, data: body });
      await app.audit(channel.guildId, req.userId, "channel.update", { targetId: channel.id, meta: { name: updated.name, changed: Object.keys(body) as ("name" | "topic")[] } });
      await app.realtime.emitToGuild(channel.guildId, "channel:updated", (canSee) => (canSee(updated.id) ? updated : null));
      return updated;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new HttpError(409, "Channel name already taken");
      throw e;
    }
  });

  app.delete<{ Params: Params }>("/guilds/:guildId/channels/:channelId", async (req, reply) => {
    const { guildId, channelId } = req.params;
    const { access } = await requireGuildChannel(channelId, req.userId, Permission.MANAGE_CHANNELS);
    const { guild } = access;
    if (guild.id !== guildId) throw NOT_FOUND;
    const threadIds = await prisma.$transaction(async (tx) => {
      await lockGuild(tx, guild.id);
      const channel = await tx.channel.findFirst({ where: { id: channelId, guildId: guild.id, parentChannelId: null } });
      if (!channel) throw NOT_FOUND;
      if ((await tx.channel.count({ where: { guildId: guild.id, parentChannelId: null } })) === 1) {
        throw new HttpError(409, "A guild must keep at least one channel");
      }
      const threads = await tx.channel.findMany({ where: { parentChannelId: channel.id }, select: { id: true } });
      await tx.channel.delete({ where: { id: channel.id } }); // its threads (and their messages) cascade
      await app.audit(guild.id, req.userId, "channel.delete", { targetId: channel.id, meta: { name: channel.name }, tx });
      return threads.map((t) => t.id);
    });
    app.realtime.closeChannels([channelId, ...threadIds]);
    return reply.code(204).send();
  });

  app.get<{ Params: Params }>("/guilds/:guildId/members", async (req) => {
    const { guild } = await requireMember(req.params.guildId, req.userId);
    const members = await prisma.member.findMany({
      where: { guildId: guild.id },
      select: { userId: true, joinedAt: true, user: { select: { username: true, isBot: true, createdAt: true, displayName: true, avatarHash: true } }, roles: { select: { roleId: true } } },
      orderBy: { joinedAt: "asc" },
    });
    const status = await app.realtime.statusOf(req.userId, members.map((m) => m.userId));
    return members.map((m) => ({
      userId: m.userId,
      username: m.user.username,
      displayName: m.user.displayName,
      avatarHash: m.user.avatarHash,
      isBot: m.user.isBot,
      joinedAt: m.joinedAt,
      createdAt: m.user.createdAt, // when the account was made ("member of Loop since")
      roleIds: m.roles.map((r) => r.roleId),
      status: status.get(m.userId) ?? "offline", // as the caller may see it (invisible / blocked -> offline)
    }));
  });

  app.delete<{ Params: Params }>("/guilds/:guildId/members/me", async (req, reply) => {
    const { guild } = await requireMember(req.params.guildId, req.userId);
    if (!(await removeMember(guild.id, req.userId))) {
      throw new HttpError(409, "The owner cannot leave; transfer ownership or delete the guild instead");
    }
    app.realtime.leaveChannels(req.userId, await channelIdsOf(guild.id));
    return reply.code(204).send();
  });

  /** Kick. Static `members/me` (leave) wins over this route in Fastify's router. */
  app.delete<{ Params: Params }>("/guilds/:guildId/members/:userId", async (req, reply) => {
    const access = await requireGuildPermission(req.params.guildId, req.userId, Permission.KICK_MEMBERS);
    const { userId } = req.params;
    await requireManageableMember(access, userId, false);
    const logKick = (tx: Prisma.TransactionClient) => app.audit(access.guild.id, req.userId, "member.kick", { targetUserId: userId, tx });
    if (!(await removeMember(access.guild.id, userId, logKick))) throw new HttpError(403, "The owner cannot be kicked");
    app.realtime.leaveChannels(userId, await channelIdsOf(access.guild.id));
    return reply.code(204).send();
  });

  /** Afterwards the old owner is a plain member (keeping only the roles they hold) and may leave. */
  app.post<{ Params: Params }>("/guilds/:guildId/transfer", async (req, reply) => {
    const { guild } = await requireOwner(req.params.guildId, req.userId);
    const body = parse(transferOwnershipSchema, req.body, reply);
    if (!body) return;
    if (body.userId === req.userId) throw new HttpError(400, "You already own this guild");
    const updated = await prisma.$transaction(async (tx) => {
      await lockGuild(tx, guild.id);
      // re-read under the lock: of two concurrent transfers, the second sees it no longer owns the guild
      const current = await tx.guild.findUnique({ where: { id: guild.id } });
      if (!current) throw NOT_FOUND;
      if (current.ownerId !== req.userId) throw new HttpError(403, "Only the owner can do this");
      const target = await tx.member.findUnique({ where: { guildId_userId: { guildId: guild.id, userId: body.userId } } });
      if (!target) throw NOT_FOUND;
      await app.audit(guild.id, req.userId, "guild.transfer", { targetUserId: body.userId, tx });
      return tx.guild.update({ where: { id: guild.id }, data: { ownerId: body.userId } });
    });
    await app.realtime.revalidate(guild.id, [req.userId]);
    return { guild: updated };
  });
}
