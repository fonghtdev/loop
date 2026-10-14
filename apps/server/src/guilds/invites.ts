import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createInviteSchema, Permission } from "@loop/shared";
import { prisma } from "../db.js";
import { parse } from "../http.js";
import { NOT_FOUND, requireGuildPermission } from "./access.js";

// 6 random bytes -> 8 URL-safe chars. ponytail: a collision (2^48 space) would surface as a 500; retry if invites ever get dense
const newInviteCode = () => randomBytes(6).toString("base64url");

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Consumes one use and creates the Member atomically; a failed join rolls back and burns nothing. `joined` is false for an existing member. */
async function joinWithInvite(code: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.invite.findUnique({ where: { code } });
    if (!invite) throw NOT_FOUND;
    const member = await tx.member.findUnique({ where: { guildId_userId: { guildId: invite.guildId, userId } } });
    if (member) return { guildId: invite.guildId, joined: false };
    const { count } = await tx.invite.updateMany({
      where: {
        code,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        AND: { OR: [{ maxUses: null }, { uses: { lt: prisma.invite.fields.maxUses } }] },
      },
      data: { uses: { increment: 1 } },
    });
    if (count === 0) throw NOT_FOUND;
    await tx.member.create({ data: { guildId: invite.guildId, userId } });
    return { guildId: invite.guildId, joined: true };
  });
}

export function inviteRoutes(app: FastifyInstance) {
  app.post<{ Params: { guildId: string } }>("/guilds/:guildId/invites", async (req, reply) => {
    const { guild } = await requireGuildPermission(req.params.guildId, req.userId, Permission.CREATE_INVITE);
    const body = parse(createInviteSchema, req.body ?? {}, reply);
    if (!body) return;
    const invite = await prisma.invite.create({
      data: {
        code: newInviteCode(),
        guildId: guild.id,
        createdById: req.userId,
        maxUses: body.maxUses,
        expiresAt: body.expiresInSeconds ? new Date(Date.now() + body.expiresInSeconds * 1000) : null,
      },
    });
    return reply.code(201).send(invite);
  });

  app.post<{ Params: { code: string } }>("/invites/:code/join", async (req) => {
    const { code } = req.params;
    let result: { guildId: string; joined: boolean };
    try {
      result = await joinWithInvite(code, req.userId);
    } catch (e) {
      // Same user joined concurrently: the other request won and this one rolled back, so they are a member.
      if (!isUniqueViolation(e)) throw e;
      result = { guildId: (await prisma.invite.findUniqueOrThrow({ where: { code } })).guildId, joined: false };
    }
    const { guildId } = result;
    if (result.joined) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { id: true, username: true, isBot: true } });
      await app.realtime.emitToGuild(guildId, "member:joined", () => ({ guildId, user }));
    }
    return { guild: await prisma.guild.findUniqueOrThrow({ where: { id: guildId } }) };
  });
}
