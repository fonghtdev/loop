import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { historyQuerySchema, messageBodySchema } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { isUuid, NOT_FOUND, requireChannelMember } from "../guilds/access.js";

const select = {
  id: true,
  seq: true,
  channelId: true,
  content: true,
  createdAt: true,
  editedAt: true,
  author: { select: { id: true, username: true } }, // never email/passwordHash
} satisfies Prisma.MessageSelect;

/** The one place seq (BigInt) becomes a JSON-safe string. */
const toDto = ({ seq, ...m }: Prisma.MessageGetPayload<{ select: typeof select }>) => ({ ...m, seq: String(seq) });

const isMissingRow = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";

/** Message by id, only if the user is a member of its guild (else 404, same as an unknown id). */
async function requireMessage(messageId: string, userId: string) {
  const message = isUuid(messageId)
    ? await prisma.message.findUnique({ where: { id: messageId }, select: { id: true, channelId: true, author: { select: { id: true } } } })
    : null;
  if (!message) throw NOT_FOUND;
  const channel = await requireChannelMember(message.channelId, userId);
  return { message, channel };
}

export function messageRoutes(app: FastifyInstance) {
  app.post<{ Params: { channelId: string } }>("/channels/:channelId/messages", async (req, reply) => {
    const channel = await requireChannelMember(req.params.channelId, req.userId);
    const body = parse(messageBodySchema, req.body, reply);
    if (!body) return;
    if (channel.type !== "TEXT") throw new HttpError(400, "Only text channels accept messages");
    const message = toDto(
      await prisma.message.create({ data: { channelId: channel.id, authorId: req.userId, content: body.content }, select }),
    );
    app.realtime.emit(channel.id, "message:new", message);
    return reply.code(201).send(message);
  });

  /**
   * Always ascending by seq. No cursor: the newest `limit`. `before`: the `limit` messages just older than it.
   * `after` (reconnect catch-up): the `limit` messages just newer than it; page on with after = last seq.
   */
  app.get<{ Params: { channelId: string } }>("/channels/:channelId/messages", async (req, reply) => {
    const channel = await requireChannelMember(req.params.channelId, req.userId);
    const q = parse(historyQuerySchema, req.query, reply);
    if (!q) return;
    const newerFirst = !q.after;
    const rows = await prisma.message.findMany({
      where: {
        channelId: channel.id,
        seq: { lt: q.before ? BigInt(q.before) : undefined, gt: q.after ? BigInt(q.after) : undefined },
      },
      orderBy: { seq: newerFirst ? "desc" : "asc" },
      take: q.limit,
      select,
    });
    if (newerFirst) rows.reverse();
    return { messages: rows.map(toDto) };
  });

  app.patch<{ Params: { messageId: string } }>("/messages/:messageId", async (req, reply) => {
    const { message, channel } = await requireMessage(req.params.messageId, req.userId);
    if (message.author.id !== req.userId) throw new HttpError(403, "Only the author can edit a message");
    const body = parse(messageBodySchema, req.body, reply);
    if (!body) return;
    try {
      const updated = toDto(
        await prisma.message.update({ where: { id: message.id }, data: { content: body.content, editedAt: new Date() }, select }),
      );
      app.realtime.emit(channel.id, "message:update", updated);
      return updated;
    } catch (e) {
      throw isMissingRow(e) ? NOT_FOUND : e; // deleted between lookup and update
    }
  });

  app.delete<{ Params: { messageId: string } }>("/messages/:messageId", async (req, reply) => {
    const { message, channel } = await requireMessage(req.params.messageId, req.userId);
    // Delete rule lives here only; step 5 replaces it with `can(member, channel, "MANAGE_MESSAGES")`.
    const allowed = message.author.id === req.userId || channel.guild.ownerId === req.userId;
    if (!allowed) throw new HttpError(403, "Not allowed to delete this message");
    const { count } = await prisma.message.deleteMany({ where: { id: message.id } });
    if (count === 0) throw NOT_FOUND;
    app.realtime.emit(channel.id, "message:delete", { id: message.id, channelId: channel.id });
    return reply.code(204).send();
  });
}
