import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createChannelSchema, createGuildSchema } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { isUuid, NOT_FOUND, requireMember, requireOwner } from "./access.js";

type Params = { guildId: string; channelId: string };

const channelIdsOf = async (guildId: string) =>
  (await prisma.channel.findMany({ where: { guildId }, select: { id: true } })).map((c) => c.id);

// Serializes channel create/delete per guild so "next position" and "keep one channel" cannot race.
const lockGuild = (tx: Prisma.TransactionClient, guildId: string) =>
  tx.$queryRaw`SELECT id FROM "Guild" WHERE id = ${guildId}::uuid FOR UPDATE`;

// ponytail: no cap on guilds per user or channels per guild; add limits before public launch
export function guildRoutes(app: FastifyInstance) {
  app.post("/guilds", async (req, reply) => {
    const body = parse(createGuildSchema, req.body, reply);
    if (!body) return;
    const guild = await prisma.guild.create({
      data: {
        name: body.name,
        ownerId: req.userId,
        members: { create: { userId: req.userId } },
        channels: { create: { name: "general", type: "TEXT", position: 0 } },
      },
      include: { channels: true },
    });
    const { channels, ...rest } = guild;
    return reply.code(201).send({ guild: rest, channels });
  });

  app.get("/guilds", async (req) =>
    prisma.guild.findMany({
      where: { members: { some: { userId: req.userId } } },
      orderBy: { createdAt: "asc" },
    }),
  );

  app.get<{ Params: Params }>("/guilds/:guildId", async (req) => {
    const guild = await requireMember(req.params.guildId, req.userId);
    const channels = await prisma.channel.findMany({
      where: { guildId: guild.id },
      orderBy: { position: "asc" },
    });
    return { guild, channels };
  });

  app.delete<{ Params: Params }>("/guilds/:guildId", async (req, reply) => {
    const guild = await requireOwner(req.params.guildId, req.userId);
    const channelIds = await channelIdsOf(guild.id);
    await prisma.guild.delete({ where: { id: guild.id } });
    app.realtime.closeChannels(channelIds);
    return reply.code(204).send();
  });

  app.post<{ Params: Params }>("/guilds/:guildId/channels", async (req, reply) => {
    const guild = await requireOwner(req.params.guildId, req.userId);
    const body = parse(createChannelSchema, req.body, reply);
    if (!body) return;
    try {
      const channel = await prisma.$transaction(async (tx) => {
        await lockGuild(tx, guild.id);
        const last = await tx.channel.aggregate({ where: { guildId: guild.id }, _max: { position: true } });
        return tx.channel.create({
          data: { guildId: guild.id, ...body, position: (last._max.position ?? -1) + 1 },
        });
      });
      return reply.code(201).send(channel);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new HttpError(409, "Channel name already taken");
      }
      throw e;
    }
  });

  app.delete<{ Params: Params }>("/guilds/:guildId/channels/:channelId", async (req, reply) => {
    const guild = await requireOwner(req.params.guildId, req.userId);
    const { channelId } = req.params;
    if (!isUuid(channelId)) throw NOT_FOUND;
    await prisma.$transaction(async (tx) => {
      await lockGuild(tx, guild.id);
      const channel = await tx.channel.findFirst({ where: { id: channelId, guildId: guild.id } });
      if (!channel) throw NOT_FOUND;
      if ((await tx.channel.count({ where: { guildId: guild.id } })) === 1) {
        throw new HttpError(409, "A guild must keep at least one channel");
      }
      await tx.channel.delete({ where: { id: channel.id } });
    });
    app.realtime.closeChannels([channelId]);
    return reply.code(204).send();
  });

  app.get<{ Params: Params }>("/guilds/:guildId/members", async (req) => {
    const guild = await requireMember(req.params.guildId, req.userId);
    const members = await prisma.member.findMany({
      where: { guildId: guild.id },
      select: { userId: true, joinedAt: true, user: { select: { username: true } } },
      orderBy: { joinedAt: "asc" },
    });
    return members.map((m) => ({ userId: m.userId, username: m.user.username, joinedAt: m.joinedAt }));
  });

  app.delete<{ Params: Params }>("/guilds/:guildId/members/me", async (req, reply) => {
    const guild = await requireMember(req.params.guildId, req.userId);
    if (guild.ownerId === req.userId) throw new HttpError(409, "The owner cannot leave; delete the guild instead");
    await prisma.member.deleteMany({ where: { guildId: guild.id, userId: req.userId } });
    app.realtime.leaveChannels(req.userId, await channelIdsOf(guild.id));
    return reply.code(204).send();
  });
}
