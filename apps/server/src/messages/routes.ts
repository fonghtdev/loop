import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { hasPermission, historyQuerySchema, messageBodySchema, Permission } from "@loop/shared";
import type { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { isUuid, NOT_FOUND, requireChannelPermission } from "../guilds/access.js";
import { requireDm } from "../social/access.js";

export const select = {
  id: true,
  seq: true,
  channelId: true, // null for DM messages
  dmChannelId: true, // null for guild messages
  content: true,
  createdAt: true,
  editedAt: true,
  author: { select: { id: true, username: true } }, // never email/passwordHash
} satisfies Prisma.MessageSelect;

/** The one place seq (BigInt) becomes a JSON-safe string. */
export const toDto = ({ seq, ...m }: Prisma.MessageGetPayload<{ select: typeof select }>) => ({ ...m, seq: String(seq) });

const isMissingRow = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";

/**
 * Always ascending by seq. No cursor: the newest `limit`. `before`: the `limit` messages just older than it.
 * `after` (reconnect catch-up): the `limit` messages just newer than it; page on with after = last seq.
 * Shared by guild channels and DMs: `where` picks the conversation.
 */
export async function history(where: Prisma.MessageWhereInput, q: z.output<typeof historyQuerySchema>) {
  const newerFirst = !q.after;
  const rows = await prisma.message.findMany({
    where: { ...where, seq: { lt: q.before ? BigInt(q.before) : undefined, gt: q.after ? BigInt(q.after) : undefined } },
    orderBy: { seq: newerFirst ? "desc" : "asc" },
    take: q.limit,
    select,
  });
  if (newerFirst) rows.reverse();
  return { messages: rows.map(toDto) };
}

/**
 * Message by id, only if the caller may see its conversation (else 404, same as an unknown id): a guild
 * message needs VIEW on its channel, a DM message needs the caller to be a participant. Also says who may
 * delete other people's messages (MANAGE_MESSAGES; nobody in a DM) and how to announce a change.
 * Edit/delete of your own DM message stays allowed after an unfriend or block.
 */
async function requireMessage(app: FastifyInstance, messageId: string, userId: string) {
  const message = isUuid(messageId)
    ? await prisma.message.findUnique({
        where: { id: messageId },
        select: { id: true, channelId: true, dmChannelId: true, author: { select: { id: true } } },
      })
    : null;
  if (!message) throw NOT_FOUND;
  if (message.dmChannelId) {
    const { dm } = await requireDm(message.dmChannelId, userId);
    return {
      message,
      canModerate: false,
      announceUpdate: (dto: object) => app.realtime.emitDm(dm, "update", dto),
      announceDelete: () => app.realtime.emitDm(dm, "delete", { id: message.id, dmChannelId: dm.id }),
    };
  }
  const { channel, perms } = await requireChannelPermission(message.channelId!, userId);
  return {
    message,
    canModerate: hasPermission(perms, Permission.MANAGE_MESSAGES),
    announceUpdate: (dto: object) => app.realtime.emit(channel.id, "message:update", dto),
    announceDelete: () => app.realtime.emit(channel.id, "message:delete", { id: message.id, channelId: channel.id }),
  };
}

export function messageRoutes(app: FastifyInstance) {
  app.post<{ Params: { channelId: string } }>("/channels/:channelId/messages", async (req, reply) => {
    const { channel } = await requireChannelPermission(req.params.channelId, req.userId, Permission.SEND_MESSAGES);
    const body = parse(messageBodySchema, req.body, reply);
    if (!body) return;
    if (channel.type !== "TEXT") throw new HttpError(400, "Only text channels accept messages");
    const message = toDto(
      await prisma.message.create({ data: { channelId: channel.id, authorId: req.userId, content: body.content }, select }),
    );
    app.realtime.emit(channel.id, "message:new", message);
    return reply.code(201).send(message);
  });

  app.get<{ Params: { channelId: string } }>("/channels/:channelId/messages", async (req, reply) => {
    const { channel } = await requireChannelPermission(req.params.channelId, req.userId);
    const q = parse(historyQuerySchema, req.query, reply);
    if (!q) return;
    return history({ channelId: channel.id }, q);
  });

  app.patch<{ Params: { messageId: string } }>("/messages/:messageId", async (req, reply) => {
    const { message, announceUpdate } = await requireMessage(app, req.params.messageId, req.userId);
    if (message.author.id !== req.userId) throw new HttpError(403, "Only the author can edit a message");
    const body = parse(messageBodySchema, req.body, reply);
    if (!body) return;
    try {
      const updated = toDto(
        await prisma.message.update({ where: { id: message.id }, data: { content: body.content, editedAt: new Date() }, select }),
      );
      announceUpdate(updated);
      return updated;
    } catch (e) {
      throw isMissingRow(e) ? NOT_FOUND : e; // deleted between lookup and update
    }
  });

  app.delete<{ Params: { messageId: string } }>("/messages/:messageId", async (req, reply) => {
    const { message, canModerate, announceDelete } = await requireMessage(app, req.params.messageId, req.userId);
    const allowed = message.author.id === req.userId || canModerate;
    if (!allowed) throw new HttpError(403, "Not allowed to delete this message");
    const { count } = await prisma.message.deleteMany({ where: { id: message.id } });
    if (count === 0) throw NOT_FOUND;
    announceDelete();
    return reply.code(204).send();
  });
}
