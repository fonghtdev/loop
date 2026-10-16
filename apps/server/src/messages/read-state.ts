import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { readBodySchema, type ReadUpdatedEvent, type UnreadResponse } from "@loop/shared";
import { prisma } from "../db.js";
import { parse } from "../http.js";
import { requireChannelPermission, viewableTextChannels } from "../guilds/access.js";
import { requireDm } from "../social/access.js";

/** The most any badge counts; the list stops reading messages at this many per conversation. */
const COUNT_CAP = 99;
type Conversation = { channelId: string } | { dmChannelId: string };
// The two column names are constants, never user input.
const column = (c: Conversation) => Prisma.raw("channelId" in c ? '"channelId"' : '"dmChannelId"');
const idOf = (c: Conversation) => ("channelId" in c ? c.channelId : c.dmChannelId);

/**
 * Moves the caller's read pointer forward to `seq` (clamped to the newest message, so a lie cannot hide messages
 * that do not exist yet) and tells their other devices. Never moves back; an older or equal `seq` changes nothing
 * and announces nothing.
 */
async function markRead(app: FastifyInstance, userId: string, c: Conversation, seq: string) {
  const col = column(c);
  const rows = await prisma.$queryRaw<{ seq: string }[]>`
    INSERT INTO "ReadState" ("userId", ${col}, "lastReadSeq")
    VALUES (${userId}::uuid, ${idOf(c)}::uuid,
      LEAST(${seq}::bigint, COALESCE((SELECT max(m.seq) FROM "Message" m WHERE m.${col} = ${idOf(c)}::uuid), 0)))
    ON CONFLICT ("userId", ${col}) WHERE ${col} IS NOT NULL
    DO UPDATE SET "lastReadSeq" = EXCLUDED."lastReadSeq", "updatedAt" = now()
      WHERE "ReadState"."lastReadSeq" < EXCLUDED."lastReadSeq"
    RETURNING "lastReadSeq"::text AS seq`;
  if (rows[0]) app.realtime.emitToUsers([userId], "read:updated", { ...c, lastReadSeq: rows[0].seq } satisfies ReadUpdatedEvent);
}

/**
 * A conversation the user has no pointer for yet counts as fully read: the pointer is created at its newest message,
 * so existing users do not wake up to hundreds of unread messages. (ponytail: a channel that is new to the user and
 * already has messages at their next /me/unread therefore starts read; upgrade = point at the user's join time.)
 */
async function seedMissing(userId: string, c: "channelId" | "dmChannelId", ids: string[]) {
  if (!ids.length) return;
  const col = Prisma.raw(`"${c}"`);
  await prisma.$executeRaw`
    INSERT INTO "ReadState" ("userId", ${col}, "lastReadSeq")
    SELECT ${userId}::uuid, c.id, COALESCE((SELECT max(m.seq) FROM "Message" m WHERE m.${col} = c.id), 0)
    FROM unnest(${ids}::uuid[]) AS c(id)
    WHERE NOT EXISTS (SELECT 1 FROM "ReadState" r WHERE r."userId" = ${userId}::uuid AND r.${col} = c.id)
    ON CONFLICT DO NOTHING`;
}

type Counted = { id: string; unread: number; mentions: number };

/**
 * Unread (messages after the pointer that someone else wrote) and mentions (those with a MessageMention for the
 * caller, or @everyone / @here; the channel list is already limited to what the caller can VIEW), each capped.
 * One round trip for all the conversations; each is a bounded range scan on (conversation, seq).
 */
const counts = (userId: string, c: "channelId" | "dmChannelId", ids: string[]) => {
  const col = Prisma.raw(`"${c}"`);
  return prisma.$queryRaw<Counted[]>`
    SELECT r.${col}::text AS id,
      (SELECT count(*) FROM (
        SELECT 1 FROM "Message" m
        WHERE m.${col} = r.${col} AND m.seq > r."lastReadSeq" AND m."authorId" <> r."userId" LIMIT ${COUNT_CAP}) a)::int AS unread,
      (SELECT count(*) FROM (
        SELECT 1 FROM "Message" m
        WHERE m.${col} = r.${col} AND m.seq > r."lastReadSeq" AND m."authorId" <> r."userId"
          AND (m."mentionEveryone" OR EXISTS (SELECT 1 FROM "MessageMention" mm WHERE mm."messageId" = m.id AND mm."userId" = r."userId"))
        LIMIT ${COUNT_CAP}) b)::int AS mentions
    FROM "ReadState" r
    WHERE r."userId" = ${userId}::uuid AND r.${col} = ANY(${ids}::uuid[])`;
};

export function readStateRoutes(app: FastifyInstance) {
  app.put<{ Params: { channelId: string } }>("/channels/:channelId/read", async (req, reply) => {
    const { channel } = await requireChannelPermission(req.params.channelId, req.userId);
    const body = parse(readBodySchema, req.body, reply);
    if (!body) return;
    await markRead(app, req.userId, { channelId: channel.id }, body.seq);
    return reply.code(204).send();
  });

  // A DM stays readable (and markable) after an unfriend or block, like its history.
  app.put<{ Params: { dmId: string } }>("/dms/:dmId/read", async (req, reply) => {
    const { dm } = await requireDm(req.params.dmId, req.userId);
    const body = parse(readBodySchema, req.body, reply);
    if (!body) return;
    await markRead(app, req.userId, { dmChannelId: dm.id }, body.seq);
    return reply.code(204).send();
  });

  /** Only conversations with something unread or a mention are listed. */
  app.get("/me/unread", async (req): Promise<UnreadResponse> => {
    const me = req.userId;
    const channels = await viewableTextChannels(me);
    const dmIds = (await prisma.dmParticipant.findMany({ where: { userId: me }, select: { dmChannelId: true } })).map((d) => d.dmChannelId);
    const channelIds = channels.map((c) => c.id);
    await Promise.all([seedMissing(me, "channelId", channelIds), seedMissing(me, "dmChannelId", dmIds)]);
    const [channelCounts, dmCounts] = await Promise.all([
      channelIds.length ? counts(me, "channelId", channelIds) : [],
      dmIds.length ? counts(me, "dmChannelId", dmIds) : [],
    ]);
    const byId = new Map(channels.map((c) => [c.id, c]));
    const some = (r: Counted) => r.unread > 0 || r.mentions > 0;
    // a thread says which channel it hangs off, so clients count it under the thread and not in the channel list
    const where = (id: string) => {
      const { guildId, parentChannelId } = byId.get(id)!;
      return parentChannelId ? { guildId, parentChannelId } : { guildId };
    };
    return {
      channels: channelCounts.filter(some).map((r) => ({ channelId: r.id, ...where(r.id), unread: r.unread, mentions: r.mentions })),
      dms: dmCounts.filter(some).map((r) => ({ dmChannelId: r.id, unread: r.unread, mentions: r.mentions })),
    };
  });
}
