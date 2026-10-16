import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  createThreadSchema,
  hasPermission,
  MAX_THREADS_LISTED,
  Permission,
  type ThreadDeletedEvent,
  type ThreadDto,
  threadListQuerySchema,
  updateThreadSchema,
} from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { isUuid, NOT_FOUND, requireChannelPermission } from "../guilds/access.js";
import { removeObjects } from "../attachments/sweep.js";

/**
 * Threads are Channel rows of type THREAD (see the threads migration): every message, read state, attachment,
 * reaction, pin, search and subscription path is the channel one, with the thread id as the channel id, and
 * `guilds/access.ts` resolves a thread's permissions from its parent. This file only adds the thread lifecycle.
 */
export const threadSelect = {
  id: true,
  guildId: true,
  parentChannelId: true,
  name: true,
  starterMessageId: true,
  createdById: true,
  createdAt: true,
  lastMessageAt: true,
  archived: true,
  _count: { select: { messages: true } },
} satisfies Prisma.ChannelSelect;

type ThreadRow = Prisma.ChannelGetPayload<{ select: typeof threadSelect }>;

export const threadDto = ({ _count, parentChannelId, createdAt, lastMessageAt, ...t }: ThreadRow): ThreadDto => ({
  ...t,
  parentChannelId: parentChannelId!,
  createdAt: createdAt.toISOString(),
  lastMessageAt: lastMessageAt?.toISOString() ?? null,
  messageCount: _count.messages,
});

const loadThread = async (id: string) => threadDto(await prisma.channel.findUniqueOrThrow({ where: { id }, select: threadSelect }));

/** `thread:created|updated|deleted` to the user room of every member who can VIEW the parent (so, the thread). */
const announce = (app: FastifyInstance, guildId: string, parentChannelId: string, event: string, payload: object) =>
  app.realtime.emitToGuild(guildId, event, (canSee) => (canSee(parentChannelId) ? payload : null));

/**
 * A message came or went in a thread: the new count and activity time go to whoever has the parent channel open
 * (its room, not every member: this fires per message), so the starter's chip follows live.
 */
export async function announceThreadActivity(app: FastifyInstance, threadId: string) {
  const thread = await prisma.channel.findUnique({ where: { id: threadId }, select: threadSelect });
  if (thread?.parentChannelId) app.realtime.emit(thread.parentChannelId, "thread:updated", threadDto(thread));
}

/** Thread summaries for the starter messages among `messageIds` (one query for a whole page). */
export async function threadsOf(messageIds: string[]) {
  if (!messageIds.length) return new Map<string, ThreadDto>();
  const rows = await prisma.channel.findMany({ where: { starterMessageId: { in: messageIds } }, select: threadSelect });
  return new Map(rows.map((r) => [r.starterMessageId!, threadDto(r)]));
}

/** A thread the caller can see (its parent's VIEW; anything else, a plain channel included, is the same 404). */
async function requireThread(threadId: string, userId: string) {
  const found = await requireChannelPermission(threadId, userId);
  if (found.channel.type !== "THREAD") throw NOT_FOUND;
  // rename / archive / delete: its creator, or whoever may manage messages in the parent
  const canManage = found.channel.createdById === userId || hasPermission(found.perms, Permission.MANAGE_MESSAGES);
  return { ...found, canManage };
}

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export function threadRoutes(app: FastifyInstance) {
  /** Starts a thread from a message of a TEXT channel: VIEW + SEND_MESSAGES there. One thread per message (409 says which). */
  app.post<{ Params: { channelId: string; messageId: string } }>("/channels/:channelId/messages/:messageId/thread", async (req, reply) => {
    const { channel } = await requireChannelPermission(req.params.channelId, req.userId, Permission.SEND_MESSAGES);
    if (channel.type === "THREAD") throw new HttpError(400, "Threads cannot have threads");
    if (channel.type !== "TEXT") throw new HttpError(400, "Only text channels have threads");
    const body = parse(createThreadSchema, req.body, reply);
    if (!body) return;
    const { messageId } = req.params;
    // the starter must be a (still existing) message of this very channel; a message in a thread lives in the thread's channel
    if (!isUuid(messageId) || !(await prisma.message.count({ where: { id: messageId, channelId: channel.id } }))) throw NOT_FOUND;
    try {
      const now = new Date();
      const { id } = await prisma.channel.create({
        data: {
          guildId: channel.guildId,
          parentChannelId: channel.id,
          type: "THREAD",
          name: body.name,
          position: 0,
          starterMessageId: messageId,
          createdById: req.userId,
          createdAt: now,
          lastMessageAt: now,
        },
        select: { id: true },
      });
      const thread = await loadThread(id);
      await announce(app, channel.guildId, channel.id, "thread:created", thread);
      return reply.code(201).send(thread);
    } catch (e) {
      if (!isUnique(e)) throw e;
      // the unique starter index decides a race: the loser learns the winner's id
      const existing = await prisma.channel.findUnique({ where: { starterMessageId: messageId }, select: { id: true } });
      return reply.code(409).send({ error: "Thread already exists", threadId: existing?.id ?? null });
    }
  });

  /** Active threads (or archived ones with `?archived=true`) of a channel the caller can VIEW, newest activity first. */
  app.get<{ Params: { channelId: string } }>("/channels/:channelId/threads", async (req, reply) => {
    const { channel } = await requireChannelPermission(req.params.channelId, req.userId);
    const q = parse(threadListQuerySchema, req.query, reply);
    if (!q) return;
    const rows = await prisma.channel.findMany({
      where: { parentChannelId: channel.id, archived: q.archived === "true" },
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }],
      take: MAX_THREADS_LISTED,
      select: threadSelect,
    });
    return { threads: rows.map(threadDto) };
  });

  app.patch<{ Params: { threadId: string } }>("/threads/:threadId", async (req, reply) => {
    const { channel, canManage } = await requireThread(req.params.threadId, req.userId);
    if (!canManage) throw new HttpError(403, "Only the thread's creator or a moderator can change it");
    const body = parse(updateThreadSchema, req.body, reply);
    if (!body) return;
    const { count } = await prisma.channel.updateMany({ where: { id: channel.id }, data: body });
    if (!count) throw NOT_FOUND; // deleted in between
    const thread = await loadThread(channel.id);
    await announce(app, channel.guildId, channel.parentChannelId!, "thread:updated", thread);
    return thread;
  });

  app.delete<{ Params: { threadId: string } }>("/threads/:threadId", async (req, reply) => {
    const { channel, canManage } = await requireThread(req.params.threadId, req.userId);
    if (!canManage) throw new HttpError(403, "Only the thread's creator or a moderator can delete it");
    const files = (await prisma.attachment.findMany({ where: { channelId: channel.id }, select: { id: true } })).map((a) => a.id);
    const { count } = await prisma.channel.deleteMany({ where: { id: channel.id } }); // its messages, read states and attachment rows cascade
    if (!count) throw NOT_FOUND;
    if (channel.createdById !== req.userId) {
      await app.audit(channel.guildId, req.userId, "message.thread_delete", { targetUserId: channel.createdById, targetId: channel.id, meta: { name: channel.name } });
    }
    await removeObjects(app.storage, files); // best effort, like deleting a message
    app.realtime.closeChannels([channel.id]);
    const gone: ThreadDeletedEvent = { id: channel.id, guildId: channel.guildId, parentChannelId: channel.parentChannelId!, starterMessageId: channel.starterMessageId };
    await announce(app, channel.guildId, gone.parentChannelId, "thread:deleted", gone);
    return reply.code(204).send();
  });
}
