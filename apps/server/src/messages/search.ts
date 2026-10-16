import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { dmSearchQuerySchema, guildSearchQuerySchema, hasPermission, Permission, searchTerms } from "@loop/shared";
import { prisma } from "../db.js";
import { bitsInChannel, permissionSource, requireMember } from "../guilds/access.js";
import { parse } from "../http.js";
import { requireDm } from "../social/access.js";
import { select, toDtos } from "./routes.js";

type Query = { q?: string; authorId?: string; before?: string; limit: number };

/**
 * Newest first, `limit` + 1 rows to learn `hasMore`. `scope` is the conversation filter the caller was cleared for.
 * Text matches the GIN index of migration `message_search`: the message and every term go through `loop_fold`
 * (lowercase, no accents), and each term is a prefix, so "chao" finds "xin chào" and "da" finds "Đạt".
 * Terms are only letters and digits (`searchTerms`), so no tsquery operator can reach the parser.
 */
async function search(scope: Prisma.Sql, q: Query, viewerId: string, storage: Parameters<typeof toDtos>[1]) {
  const terms = q.q === undefined ? undefined : searchTerms(q.q);
  if (terms && !terms.length) return { messages: [], hasMore: false };
  const where = [
    scope,
    q.authorId ? Prisma.sql`m."authorId" = ${q.authorId}::uuid` : Prisma.empty,
    q.before ? Prisma.sql`m.seq < ${q.before}::bigint` : Prisma.empty,
    terms
      ? Prisma.sql`to_tsvector('simple', loop_fold(m.content)) @@ to_tsquery('simple', (SELECT string_agg(loop_fold(t) || ':*', ' & ') FROM unnest(${terms}::text[]) t))`
      : Prisma.empty,
  ].filter((w) => w !== Prisma.empty);
  const ids = (
    await prisma.$queryRaw<{ id: string }[]>`
      SELECT m.id::text AS id FROM "Message" m WHERE ${Prisma.join(where, " AND ")} ORDER BY m.seq DESC LIMIT ${q.limit + 1}`
  ).map((r) => r.id);
  const rows = await prisma.message.findMany({ where: { id: { in: ids.slice(0, q.limit) } }, select });
  rows.sort((a, b) => (a.seq < b.seq ? 1 : -1));
  return { messages: await toDtos(rows, storage, viewerId), hasMore: ids.length > q.limit };
}

export function searchRoutes(app: FastifyInstance) {
  /** Only channels (and threads, through their parent) the caller can VIEW are searched; one they cannot see just contributes nothing. */
  app.get<{ Params: { guildId: string } }>("/guilds/:guildId/messages/search", async (req, reply) => {
    const access = await requireMember(req.params.guildId, req.userId);
    const q = parse(guildSearchQuerySchema, req.query, reply);
    if (!q) return;
    const channels = await prisma.channel.findMany({ where: { guildId: access.guild.id, type: { in: ["TEXT", "THREAD"] } }, include: permissionSource });
    const visible = channels
      .filter((c) => (!q.channelId || c.id === q.channelId) && hasPermission(bitsInChannel(access, c), Permission.VIEW_CHANNEL))
      .map((c) => c.id);
    if (!visible.length) return { messages: [], hasMore: false };
    return search(Prisma.sql`m."channelId" = ANY(${visible}::uuid[])`, q, req.userId, app.storage);
  });

  // Readable after an unfriend or block, like the history.
  app.get<{ Params: { dmId: string } }>("/dms/:dmId/messages/search", async (req, reply) => {
    const { dm } = await requireDm(req.params.dmId, req.userId);
    const q = parse(dmSearchQuerySchema, req.query, reply);
    if (!q) return;
    return search(Prisma.sql`m."dmChannelId" = ${dm.id}::uuid`, q, req.userId, app.storage);
  });
}
