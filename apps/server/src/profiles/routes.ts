import type { FastifyInstance } from "fastify";
import { updateProfileSchema, type UserUpdatedEvent } from "@loop/shared";
import { prisma } from "../db.js";
import { parse } from "../http.js";
import { isUuid, NOT_FOUND } from "../guilds/access.js";
import { areFriends, isBlockedBetween, presenceAudience } from "../social/access.js";
import { announceGuild } from "../guilds/routes.js";
import { imageRoutes, requireGuildAdmin } from "./images.js";

const profileSelect = {
  id: true, username: true, displayName: true, bio: true, statusText: true, avatarHash: true, bannerHash: true, createdAt: true,
} as const;

const sharesGuild = async (a: string, b: string) =>
  (await prisma.member.count({ where: { userId: a, guild: { members: { some: { userId: b } } } } })) > 0;

/** Everyone who shows this user's name or picture (the presence audience, plus their own other devices). */
async function announceUser(app: FastifyInstance, userId: string) {
  const { id, username, displayName, avatarHash, bannerHash, statusText } = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: profileSelect });
  const event: UserUpdatedEvent = { id, username, displayName, avatarHash, bannerHash, statusText };
  app.realtime.emitToUsers([userId, ...(await presenceAudience(userId))], "user:updated", event);
}

/** `root` carries the public image reads; `authed` everything that needs a signed-in user. */
export function profileRoutes(root: FastifyInstance, authed: FastifyInstance) {
  /** Visible to the user themself, friends and people sharing a guild; a block (either way) and strangers get the same 404 as an unknown id. */
  authed.get<{ Params: { userId: string } }>("/users/:userId/profile", async (req) => {
    const { userId } = req.params;
    const user = isUuid(userId) ? await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: profileSelect }) : null;
    if (!user) throw NOT_FOUND;
    if (user.id !== req.userId) {
      const reachable = !(await isBlockedBetween(req.userId, user.id)) && ((await areFriends(req.userId, user.id)) || (await sharesGuild(req.userId, user.id)));
      if (!reachable) throw NOT_FOUND;
    }
    return user;
  });

  authed.patch("/me/profile", async (req, reply) => {
    const body = parse(updateProfileSchema, req.body, reply);
    if (!body) return;
    const user = await prisma.user.update({ where: { id: req.userId }, data: body, select: profileSelect });
    await announceUser(authed, req.userId);
    return user;
  });

  const userImage = (field: "avatarHash" | "bannerHash") => ({
    hashOf: async (id: string) => (await prisma.user.findUnique({ where: { id } }))?.[field],
    setHash: (id: string, hash: string | null) => prisma.user.update({ where: { id }, data: { [field]: hash } }),
  });
  const own = async (req: { userId: string }) => req.userId;

  imageRoutes(root, authed, {
    avatar: { readUrl: "/users/:userId/avatar", uploadUrl: "/me/avatar", authorize: own, dir: (id) => `profile/${id}`, ...userImage("avatarHash"), announce: announceUser },
    banner: { readUrl: "/users/:userId/banner", uploadUrl: "/me/banner", authorize: own, dir: (id) => `profile/${id}`, ...userImage("bannerHash"), announce: announceUser },
    icon: {
      readUrl: "/guilds/:guildId/icon",
      uploadUrl: "/guilds/:guildId/icon",
      authorize: requireGuildAdmin,
      dir: (id) => `guilds/${id}`,
      hashOf: async (id) => (await prisma.guild.findUnique({ where: { id }, select: { iconHash: true } }))?.iconHash,
      setHash: (id, hash) => prisma.guild.update({ where: { id }, data: { iconHash: hash } }),
      announce: async (app, id, { actorId, removed }) => {
        await app.audit(id, actorId, "guild.icon", { meta: { removed } });
        await announceGuild(app, id);
      },
    },
  });
}
