import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createBotSchema, emailSchema, MAX_BOTS_PER_USER } from "@loop/shared";
import { signAccessToken } from "../auth/tokens.js";
import { prisma } from "../db.js";
import { isUuid, NOT_FOUND } from "../guilds/access.js";
import { HttpError, parse } from "../http.js";

/**
 * Bot accounts. A bot is a User (isBot, ownerId) that logs in with `<botUserId>.<secret>` instead of a password
 * and then uses the normal REST / Socket.IO / voice routes. Only SHA-256(secret) is stored; the raw token is
 * shown once, at creation or rotation. Access tokens of a bot carry that hash and die with it (auth/tokens.ts).
 */
const INVALID_BOT_TOKEN = new HttpError(401, "Invalid bot token");
const NO_BOTS_FOR_BOTS = new HttpError(403, "Bots cannot manage bots");

// ponytail: plain SHA-256 is fine because the secret is 256 bits of randomness (no brute force)
const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");
const DUMMY_HASH = hashSecret("dummy-bot-secret");

const newToken = (botId: string) => {
  const secret = randomBytes(32).toString("base64url");
  return { token: `${botId}.${secret}`, hash: hashSecret(secret) };
};

const botSelect = { id: true, username: true, createdAt: true } as const;

/** Unknown, deleted, malformed, someone else's bot: all the same 401, compared in constant time. */
export async function botLogin(token: string, jwtSecret: string) {
  const dot = token.indexOf(".");
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (dot < 0 || !isUuid(id) || !secret) throw INVALID_BOT_TOKEN;
  const bot = await prisma.user.findFirst({ where: { id, isBot: true, deletedAt: null } });
  const stored = Buffer.from(bot?.botTokenHash ?? DUMMY_HASH, "hex");
  const ok = timingSafeEqual(Buffer.from(hashSecret(secret), "hex"), stored);
  if (!bot?.botTokenHash || !ok) throw INVALID_BOT_TOKEN;
  // Same shape as /auth/login minus the refresh token: a bot logs in again when its access token expires.
  return {
    user: { id: bot.id, email: bot.email, username: bot.username },
    accessToken: await signAccessToken(bot.id, jwtSecret, bot.botTokenHash),
  };
}

/** The caller must be a person. */
async function requireHuman(userId: string) {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { isBot: true } });
  if (!me || me.isBot) throw NO_BOTS_FOR_BOTS;
}

/** The caller's live bot; anyone else's (or unknown, deleted, malformed) is the same 404. */
async function requireOwnBot(botId: string, ownerId: string) {
  await requireHuman(ownerId);
  const bot = isUuid(botId)
    ? await prisma.user.findFirst({ where: { id: botId, isBot: true, ownerId, deletedAt: null }, select: botSelect })
    : null;
  if (!bot) throw NOT_FOUND;
  return bot;
}

export function botRoutes(app: FastifyInstance) {
  /** Sockets closed and out of every voice room of its guilds: whatever ran on the old credentials stops now. */
  const cutOff = async (botId: string, guildIds: string[]) => {
    app.realtime.disconnectUser(botId);
    const channels = await prisma.channel.findMany({ where: { guildId: { in: guildIds }, type: "VOICE" }, select: { id: true } });
    await app.voice.removeUser(botId, channels.map((c) => c.id));
  };
  const guildIdsOf = async (botId: string) =>
    (await prisma.member.findMany({ where: { userId: botId }, select: { guildId: true } })).map((m) => m.guildId);

  app.post("/bots", async (req, reply) => {
    const body = parse(createBotSchema, req.body, reply);
    if (!body) return;
    await requireHuman(req.userId);
    const id = randomUUID();
    const { token, hash } = newToken(id);
    try {
      const bot = await prisma.$transaction(async (tx) => {
        // the owner's row serializes their concurrent creates, so the cap holds
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.userId}::uuid FOR UPDATE`;
        if ((await tx.user.count({ where: { ownerId: req.userId, deletedAt: null } })) >= MAX_BOTS_PER_USER) {
          throw new HttpError(409, `Bot limit reached (${MAX_BOTS_PER_USER})`);
        }
        return tx.user.create({
          data: {
            id,
            email: emailSchema.parse(`bot-${id}@bots.invalid`), // unusable: no password, never logs in by email
            username: body.name,
            passwordHash: "!",
            isBot: true,
            ownerId: req.userId,
            botTokenHash: hash,
          },
          select: botSelect,
        });
      });
      return reply.code(201).send({ bot, token });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new HttpError(409, "Username already taken");
      }
      throw e;
    }
  });

  app.get("/bots", async (req) => {
    await requireHuman(req.userId);
    return prisma.user.findMany({ where: { ownerId: req.userId, deletedAt: null }, select: botSelect, orderBy: { createdAt: "asc" } });
  });

  /** New token; the old one, every access token issued from it, its sockets and voice sessions die now. */
  app.post<{ Params: { botId: string } }>("/bots/:botId/token", async (req) => {
    const bot = await requireOwnBot(req.params.botId, req.userId);
    const { token, hash } = newToken(bot.id);
    const { count } = await prisma.user.updateMany({ where: { id: bot.id, deletedAt: null }, data: { botTokenHash: hash } });
    if (!count) throw NOT_FOUND; // deleted concurrently
    await cutOff(bot.id, await guildIdsOf(bot.id));
    return { bot, token };
  });

  /**
   * Soft delete: messages keep their author (Message.authorId is Restrict), the bot leaves every guild and can
   * never log in again. A bot that owns a guild must transfer or delete it first (like an owner leaving).
   * ponytail: the username stays taken; upgrade = rename on delete if names run short.
   */
  app.delete<{ Params: { botId: string } }>("/bots/:botId", async (req, reply) => {
    const bot = await requireOwnBot(req.params.botId, req.userId);
    const guildIds = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${bot.id}::uuid FOR UPDATE`;
      if (await tx.guild.count({ where: { ownerId: bot.id } })) {
        throw new HttpError(409, "The bot owns a guild; transfer or delete it first");
      }
      const memberships = await tx.member.findMany({ where: { userId: bot.id }, select: { guildId: true } });
      await tx.member.deleteMany({ where: { userId: bot.id } });
      await tx.user.update({ where: { id: bot.id }, data: { deletedAt: new Date(), botTokenHash: null } });
      return memberships.map((m) => m.guildId);
    });
    await cutOff(bot.id, guildIds);
    return reply.code(204).send();
  });
}
