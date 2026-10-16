import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { editMessageSchema, hasPermission, historyQuerySchema, isEmoji, linkPreviewUrls, MAX_PINS_PER_CONVERSATION, MAX_REACTION_EMOJI_PER_MESSAGE, messageBodySchema, Permission } from "@loop/shared";
import type { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { isUuid, NOT_FOUND, requireChannelPermission, requireWritableChannel } from "../guilds/access.js";
import { requireDm, requireDmWritable } from "../social/access.js";
import type { ObjectStorage } from "../storage.js";
import { claimAttachments } from "../attachments/access.js";
import { attachmentDto, attachmentSelect } from "../attachments/dto.js";
import { removeObjects } from "../attachments/sweep.js";
import { canMentionEveryone, type MentionScope, type Mentions, mentionRecipients, noMentions, resolveMentions } from "./mentions.js";
import { announceThreadActivity, threadsOf } from "./threads.js";
import { embedDtos, embedSelect } from "../embeds/dto.js";
import { enforceAutoMod } from "../guilds/automod.js";

const authorSelect = { id: true, username: true, isBot: true, displayName: true, avatarHash: true } as const; // never email/passwordHash

export const select = {
  id: true,
  seq: true,
  channelId: true, // null for DM messages
  dmChannelId: true, // null for guild messages
  content: true,
  createdAt: true,
  editedAt: true,
  replyToId: true,
  mentionEveryone: true,
  pinnedAt: true,
  author: { select: authorSelect },
  attachments: { select: attachmentSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }, // one extra query for a whole page
  // ponytail: one row per (emoji, user), so a hugely reacted message loads them all; groupBy + a "me" lookup if that ever hurts
  reactions: { select: { emoji: true, userId: true }, orderBy: { createdAt: "asc" } }, // one extra query for a whole page
  mentions: { select: { userId: true } }, // one extra query for a whole page
  embeds: embedSelect, // link previews, filled in after the send (src/embeds)
} satisfies Prisma.MessageSelect;

type Row = Prisma.MessageGetPayload<{ select: typeof select }>;

const REPLY_PREVIEW_CHARS = 140;

/** `me` is relative to `viewerId`; broadcast copies pass none (every `me` false) and clients keep their own. */
export const reactionDtos = (reactions: Row["reactions"], viewerId?: string) => {
  const byEmoji = new Map<string, { emoji: string; count: number; me: boolean }>(); // insertion order = first reaction first
  for (const r of reactions) {
    const entry = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, me: false };
    entry.count++;
    entry.me ||= r.userId === viewerId;
    byEmoji.set(r.emoji, entry);
  }
  return [...byEmoji.values()];
};

/** What a reply shows of its target: one query for all targets of the page; a target no longer there is `deleted`. */
async function replyTargets(rows: Row[]) {
  const ids = [...new Set(rows.flatMap((m) => (m.replyToId ? [m.replyToId] : [])))];
  if (!ids.length) return new Map<string, object>();
  const found = await prisma.message.findMany({
    where: { id: { in: ids } },
    select: { id: true, content: true, author: { select: authorSelect }, _count: { select: { attachments: true } } },
  });
  return new Map(
    found.map(({ _count, content, ...t }) => [
      t.id,
      { ...t, content: [...content].slice(0, REPLY_PREVIEW_CHARS).join(""), hasAttachments: _count.attachments > 0, deleted: false },
    ]),
  );
}

/** The one place seq (BigInt) becomes a JSON-safe string and attachments get their download URLs. */
export async function toDtos(rows: Row[], storage: ObjectStorage, viewerId?: string) {
  const [targets, threads] = await Promise.all([replyTargets(rows), threadsOf(rows.filter((m) => m.channelId).map((m) => m.id))]);
  return Promise.all(
    rows.map(async ({ seq, attachments, reactions, replyToId, pinnedAt, mentions, embeds, ...m }) => ({
      ...m,
      seq: String(seq),
      mentions: mentions.map((x) => x.userId),
      pinned: pinnedAt !== null,
      attachments: await Promise.all(attachments.map((a) => attachmentDto(a, storage))),
      reactions: reactionDtos(reactions, viewerId),
      replyTo: replyToId ? (targets.get(replyToId) ?? { id: replyToId, deleted: true }) : null,
      thread: threads.get(m.id) ?? null, // the thread started from this message (thread JSON), if any
      embeds: embedDtos(embeds),
    })),
  );
}
export const toDto = async (row: Row, storage: ObjectStorage, viewerId?: string) => (await toDtos([row], storage, viewerId))[0]!;

/**
 * Creates the message and claims its attachments in the caller's transaction: if any attachment is not
 * claimable the whole thing rolls back. A reply target must be a message of the same conversation (else 400,
 * the same for unknown, deleted and foreign). `mentions` is what `resolveMentions` made of the text.
 * Returns the row ready for `toDto`.
 */
export async function createMessage(
  tx: Prisma.TransactionClient,
  target: { channelId: string } | { dmChannelId: string },
  authorId: string,
  body: z.output<typeof messageBodySchema>,
  mentions: Mentions = noMentions,
) {
  const { replyToId } = body;
  if (replyToId && !(isUuid(replyToId) && (await tx.message.count({ where: { id: replyToId, ...target } }))))
    throw new HttpError(400, "Invalid reply");
  const { id } = await tx.message.create({
    data: { ...target, authorId, content: body.content, replyToId, mentionEveryone: mentions.everyone, mentions: { create: mentions.userIds.map((userId) => ({ userId })) } },
    select: { id: true },
  });
  await claimAttachments(tx, body.attachmentIds, authorId, target, id);
  return tx.message.findUniqueOrThrow({ where: { id }, select });
}

const isMissingRow = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";

/**
 * Always ascending by seq. No cursor: the newest `limit`. `before`: the `limit` messages just older than it.
 * `after` (reconnect catch-up): the `limit` messages just newer than it; page on with after = last seq.
 * Shared by guild channels and DMs: `where` picks the conversation.
 */
export async function history(where: Prisma.MessageWhereInput, q: z.output<typeof historyQuerySchema>, storage: ObjectStorage, viewerId: string) {
  const newerFirst = !q.after;
  const rows = await prisma.message.findMany({
    where: { ...where, seq: { lt: q.before ? BigInt(q.before) : undefined, gt: q.after ? BigInt(q.after) : undefined } },
    orderBy: { seq: newerFirst ? "desc" : "asc" },
    take: q.limit,
    select,
  });
  if (newerFirst) rows.reverse();
  return { messages: await toDtos(rows, storage, viewerId) };
}

/** The pinned messages of one conversation, newest pin first (at most MAX_PINS_PER_CONVERSATION, so no paging). */
export async function pinned(where: Prisma.MessageWhereInput, storage: ObjectStorage, viewerId: string) {
  const rows = await prisma.message.findMany({ where: { ...where, pinnedAt: { not: null } }, orderBy: { pinnedAt: "desc" }, take: MAX_PINS_PER_CONVERSATION, select });
  return { messages: await toDtos(rows, storage, viewerId) };
}

/**
 * Message by id, only if the caller may see its conversation (else 404, same as an unknown id): a guild
 * message needs VIEW on its channel, a DM message needs the caller to be a current participant (pair or group). Also says who may
 * delete other people's messages (MANAGE_MESSAGES; nobody in a DM) and how to announce a change.
 * Edit/delete of your own DM message stays allowed after an unfriend or block, and so does taking back a reaction.
 * `mode`: "react" asks for what sending would (SEND_MESSAGES in a channel, `requireDmWritable` in a DM); "pin" and
 * "unpin" need MANAGE_MESSAGES in a channel and any participant in a DM (a live friendship only to pin).
 */
type Mode = "read" | "react" | "pin" | "unpin";
async function requireMessage(app: FastifyInstance, messageId: string, userId: string, mode: Mode = "read") {
  const message = isUuid(messageId)
    ? await prisma.message.findUnique({
        where: { id: messageId },
        select: { id: true, channelId: true, dmChannelId: true, pinnedAt: true, author: { select: { id: true } } },
      })
    : null;
  if (!message) throw NOT_FOUND;
  if (message.dmChannelId) {
    const { dm, participantIds: to } = await (mode === "react" || mode === "pin" ? requireDmWritable : requireDm)(message.dmChannelId, userId);
    return {
      message,
      guildChannel: null,
      threadId: null,
      canModerate: false,
      mentionScope: { dmParticipantIds: to } satisfies MentionScope,
      announcePin: (pinned: boolean) => app.realtime.emitDm(to, "pin", { messageId: message.id, dmChannelId: dm.id, pinned }),
      announceUpdate: (dto: object) => app.realtime.emitDm(to, "update", dto),
      announceDelete: () => app.realtime.emitDm(to, "delete", { id: message.id, dmChannelId: dm.id }),
      announceReaction: (change: object) => app.realtime.emitDm(to, "reaction", { ...change, dmChannelId: dm.id }),
    };
  }
  const needed = { read: Permission.VIEW_CHANNEL, react: Permission.SEND_MESSAGES, pin: Permission.MANAGE_MESSAGES, unpin: Permission.MANAGE_MESSAGES }[mode];
  const { channel, perms } = await requireChannelPermission(message.channelId!, userId, needed);
  return {
    message,
    guildChannel: { channel, perms }, // AutoMod on edit, the audit entry of a moderator's delete
    threadId: channel.parentChannelId ? channel.id : null, // a thread message: its thread's count changes on delete
    canModerate: hasPermission(perms, Permission.MANAGE_MESSAGES),
    mentionScope: { guildId: channel.guildId, channelId: channel.id, canEveryone: canMentionEveryone(perms) } satisfies MentionScope,
    announcePin: (pinned: boolean) => app.realtime.emit(channel.id, "message:pin", { messageId: message.id, channelId: channel.id, pinned }),
    announceUpdate: (dto: object) => app.realtime.emit(channel.id, "message:update", dto),
    announceDelete: () => app.realtime.emit(channel.id, "message:delete", { id: message.id, channelId: channel.id }),
    announceReaction: (change: object) => app.realtime.emit(channel.id, "message:reaction", { ...change, channelId: channel.id }),
  };
}

export function messageRoutes(app: FastifyInstance) {
  app.post<{ Params: { channelId: string } }>("/channels/:channelId/messages", async (req, reply) => {
    const { channel, perms } = await requireWritableChannel(req.params.channelId, req.userId);
    const body = parse(messageBodySchema, req.body, reply);
    if (!body) return;
    await enforceAutoMod(app, channel, req.userId, perms, body.content); // before anything of the message exists
    const mentions = await resolveMentions(body.content, { guildId: channel.guildId, channelId: channel.id, canEveryone: canMentionEveryone(perms) });
    const message = await toDto(
      await prisma.$transaction(async (tx) => {
        const row = await createMessage(tx, { channelId: channel.id }, req.userId, body, mentions);
        if (channel.parentChannelId) await tx.channel.update({ where: { id: channel.id }, data: { lastMessageAt: row.createdAt } });
        return row;
      }),
      app.storage,
    );
    app.realtime.emit(channel.id, "message:new", message);
    const where = { guildId: channel.guildId, channelId: channel.id, parentChannelId: channel.parentChannelId };
    app.realtime.emitToUsers(await mentionRecipients(channel, mentions, req.userId), "mention:new", { ...where, message });
    if (channel.parentChannelId) await announceThreadActivity(app, channel.id);
    app.embeds.schedule(message.id, req.userId);
    return reply.code(201).send(message);
  });

  app.get<{ Params: { channelId: string } }>("/channels/:channelId/messages", async (req, reply) => {
    const { channel } = await requireChannelPermission(req.params.channelId, req.userId);
    const q = parse(historyQuerySchema, req.query, reply);
    if (!q) return;
    return history({ channelId: channel.id }, q, app.storage, req.userId);
  });

  app.patch<{ Params: { messageId: string } }>("/messages/:messageId", async (req, reply) => {
    const { message, announceUpdate, mentionScope, guildChannel } = await requireMessage(app, req.params.messageId, req.userId);
    if (message.author.id !== req.userId) throw new HttpError(403, "Only the author can edit a message");
    const body = parse(editMessageSchema, req.body, reply);
    if (!body) return;
    if (guildChannel) await enforceAutoMod(app, guildChannel.channel, req.userId, guildChannel.perms, body.content);
    // ponytail: attachments are immutable here (no add/remove on edit); the text may be emptied only when some remain
    if (!body.content && !(await prisma.attachment.count({ where: { messageId: message.id } })))
      throw new HttpError(400, "Content or attachment required");
    try {
      // Mentions are recomputed from the new text (no re-notification logic: clients notify on message:new only).
      const mentions = await resolveMentions(body.content, mentionScope);
      // Previews: rows of URLs still in the text stay (re-ordered), the others go; new URLs are unfurled afterwards.
      const urls = linkPreviewUrls(body.content);
      const dropped = await prisma.messageEmbed.findMany({ where: { messageId: message.id, url: { notIn: urls } }, select: { thumbHash: true } });
      const row = await prisma.message.update({
        where: { id: message.id },
        data: {
          content: body.content,
          editedAt: new Date(),
          mentionEveryone: mentions.everyone,
          mentions: { deleteMany: {}, create: mentions.userIds.map((userId) => ({ userId })) },
          embeds: { deleteMany: { url: { notIn: urls } }, updateMany: urls.map((url, position) => ({ where: { url }, data: { position } })) },
        },
        select,
      });
      await app.embeds.removeThumbs(dropped.map((e) => e.thumbHash));
      app.embeds.schedule(message.id, req.userId);
      const updated = await toDto(row, app.storage);
      announceUpdate(updated);
      return { ...updated, reactions: reactionDtos(row.reactions, req.userId) };
    } catch (e) {
      throw isMissingRow(e) ? NOT_FOUND : e; // deleted between lookup and update
    }
  });

  app.delete<{ Params: { messageId: string } }>("/messages/:messageId", async (req, reply) => {
    const { message, canModerate, announceDelete, threadId, guildChannel } = await requireMessage(app, req.params.messageId, req.userId);
    const allowed = message.author.id === req.userId || canModerate;
    if (!allowed) throw new HttpError(403, "Not allowed to delete this message");
    const ids = (await prisma.attachment.findMany({ where: { messageId: message.id }, select: { id: true } })).map((a) => a.id);
    const thumbs = (await prisma.messageEmbed.findMany({ where: { messageId: message.id }, select: { thumbHash: true } })).map((e) => e.thumbHash);
    const { count } = await prisma.message.deleteMany({ where: { id: message.id } }); // rows cascade
    if (count === 0) throw NOT_FOUND;
    // a moderator removing someone else's message: who and where, never what it said
    if (guildChannel && message.author.id !== req.userId) {
      await app.audit(guildChannel.channel.guildId, req.userId, "message.delete", { targetUserId: message.author.id, targetId: guildChannel.channel.id });
    }
    await removeObjects(app.storage, ids);
    await app.embeds.removeThumbs(thumbs);
    announceDelete();
    if (threadId) await announceThreadActivity(app, threadId);
    return reply.code(204).send();
  });

  /** Idempotent: nothing is announced when the reaction was already there. */
  app.put<{ Params: { messageId: string; emoji: string } }>("/messages/:messageId/reactions/:emoji", async (req, reply) => {
    const { message, announceReaction } = await requireMessage(app, req.params.messageId, req.userId, "react");
    const { emoji } = req.params;
    if (!isEmoji(emoji)) throw new HttpError(400, "Invalid emoji");
    const key = { messageId: message.id, userId: req.userId, emoji };
    if (await prisma.reaction.count({ where: key })) return reply.code(204).send();
    // ponytail: check-then-insert, so two first reactions racing can overshoot the limit by a few; a lock if it matters
    const used = await prisma.reaction.groupBy({ by: ["emoji"], where: { messageId: message.id } });
    if (used.length >= MAX_REACTION_EMOJI_PER_MESSAGE && !used.some((u) => u.emoji === emoji)) throw new HttpError(400, "Too many different reactions");
    try {
      const { count: inserted } = await prisma.reaction.createMany({ data: [key], skipDuplicates: true });
      if (inserted) announceReaction({ messageId: message.id, emoji, userId: req.userId, added: true, count: await prisma.reaction.count({ where: { messageId: message.id, emoji } }) });
    } catch (e) {
      throw e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003" ? NOT_FOUND : e; // deleted between lookup and insert
    }
    return reply.code(204).send();
  });

  /** Takes back the caller's own reaction; idempotent. */
  app.delete<{ Params: { messageId: string; emoji: string } }>("/messages/:messageId/reactions/:emoji", async (req, reply) => {
    const { message, announceReaction } = await requireMessage(app, req.params.messageId, req.userId);
    const { emoji } = req.params;
    const { count: removed } = await prisma.reaction.deleteMany({ where: { messageId: message.id, userId: req.userId, emoji } });
    if (removed) announceReaction({ messageId: message.id, emoji, userId: req.userId, added: false, count: await prisma.reaction.count({ where: { messageId: message.id, emoji } }) });
    return reply.code(204).send();
  });

  /** Idempotent: nothing is announced when it was already pinned. */
  app.put<{ Params: { messageId: string } }>("/messages/:messageId/pin", async (req, reply) => {
    const { message, announcePin } = await requireMessage(app, req.params.messageId, req.userId, "pin");
    if (message.pinnedAt) return reply.code(204).send();
    const scope = message.channelId ? { channelId: message.channelId } : { dmChannelId: message.dmChannelId! };
    // ponytail: count-then-write, so two first pins racing can overshoot the limit by a few; a lock if it matters
    if ((await prisma.message.count({ where: { ...scope, pinnedAt: { not: null } } })) >= MAX_PINS_PER_CONVERSATION)
      throw new HttpError(409, "Pin limit reached");
    const { count } = await prisma.message.updateMany({ where: { id: message.id, pinnedAt: null }, data: { pinnedAt: new Date(), pinnedById: req.userId } });
    if (count) announcePin(true);
    return reply.code(204).send();
  });

  /** Idempotent: nothing is announced when it was not pinned. */
  app.delete<{ Params: { messageId: string } }>("/messages/:messageId/pin", async (req, reply) => {
    const { message, announcePin } = await requireMessage(app, req.params.messageId, req.userId, "unpin");
    const { count } = await prisma.message.updateMany({ where: { id: message.id, pinnedAt: { not: null } }, data: { pinnedAt: null, pinnedById: null } });
    if (count) announcePin(false);
    return reply.code(204).send();
  });

  app.get<{ Params: { channelId: string } }>("/channels/:channelId/pins", async (req) => {
    const { channel } = await requireChannelPermission(req.params.channelId, req.userId);
    return pinned({ channelId: channel.id }, app.storage, req.userId);
  });
}
