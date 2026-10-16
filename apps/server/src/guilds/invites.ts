import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createInviteSchema, hasPermission, type InviteDto, Permission } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { NOT_FOUND, requireGuildPermission, requireMember } from "./access.js";
import { lockGuild } from "./routes.js";

// 6 random bytes -> 8 URL-safe chars. ponytail: a collision (2^48 space) would surface as a 500; retry if invites ever get dense
const newInviteCode = () => randomBytes(6).toString("base64url");

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/**
 * Consumes one use and creates the Member atomically; a failed join rolls back and burns nothing. `joined` is false for an existing member.
 * Under the guild lock, so a ban committing at the same time cannot miss the new member (and the join sees the ban).
 */
async function joinWithInvite(code: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.invite.findUnique({ where: { code } });
    if (!invite) throw NOT_FOUND;
    await lockGuild(tx, invite.guildId);
    // no reason or detail: the banned user learns only that they are banned
    if (await tx.guildBan.findUnique({ where: { guildId_userId: { guildId: invite.guildId, userId } } })) throw new HttpError(403, "You are banned from this server");
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

/**
 * Invite management: with CREATE_INVITE a member sees and revokes the invites they made; MANAGE_ROLES (so ADMINISTRATOR
 * and the owner) sees and revokes every invite of the guild. There is no MANAGE_GUILD bit; MANAGE_ROLES is the closest
 * existing "manages the server" bit (it already governs roles, assignments and overwrites).
 */
async function inviteScope(guildId: string, userId: string) {
  const access = await requireMember(guildId, userId);
  const all = hasPermission(access.perms, Permission.MANAGE_ROLES);
  if (!all && !hasPermission(access.perms, Permission.CREATE_INVITE)) throw new HttpError(403, "Missing permission");
  return { guildId: access.guild.id, all };
}

export function inviteRoutes(app: FastifyInstance) {
  app.get<{ Params: { guildId: string } }>("/guilds/:guildId/invites", async (req) => {
    const { guildId, all } = await inviteScope(req.params.guildId, req.userId);
    const rows = await prisma.invite.findMany({
      where: { guildId, ...(all ? {} : { createdById: req.userId }) },
      orderBy: { createdAt: "desc" },
      include: { createdBy: { select: { id: true, username: true } } },
    });
    const invites = rows.map((i) => ({
      code: i.code,
      createdBy: i.createdBy,
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt?.toISOString() ?? null,
      maxUses: i.maxUses,
      uses: i.uses,
    }) satisfies InviteDto);
    return { invites };
  });

  /** Revoke: the invite stops working at once (a join racing with it either got in first or gets 404). */
  app.delete<{ Params: { guildId: string; code: string } }>("/guilds/:guildId/invites/:code", async (req, reply) => {
    const { guildId, all } = await inviteScope(req.params.guildId, req.userId);
    const invite = await prisma.invite.findFirst({ where: { code: req.params.code, guildId } });
    if (!invite) throw NOT_FOUND;
    if (!all && invite.createdById !== req.userId) throw new HttpError(403, "Missing permission");
    if ((await prisma.invite.deleteMany({ where: { code: invite.code } })).count) {
      await app.audit(guildId, req.userId, "invite.revoke", { targetUserId: invite.createdById });
    }
    return reply.code(204).send();
  });

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
    // never the code: a live invite is a key to the server
    await app.audit(guild.id, req.userId, "invite.create", { meta: { maxUses: body.maxUses ?? null, expiresInSeconds: body.expiresInSeconds ?? null } });
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
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { id: true, username: true, isBot: true, displayName: true, avatarHash: true } });
      await app.realtime.emitToGuild(guildId, "member:joined", () => ({ guildId, user }));
    }
    return { guild: await prisma.guild.findUniqueOrThrow({ where: { id: guildId } }) };
  });
}
