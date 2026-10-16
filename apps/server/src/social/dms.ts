import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import {
  addGroupDmParticipantSchema,
  createGroupDmSchema,
  historyQuerySchema,
  MAX_GROUP_DM,
  messageBodySchema,
  openDmSchema,
  type PresenceStatus,
  updateGroupDmSchema,
} from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { presenceFields } from "../presence.js";
import { resolveMentions } from "../messages/mentions.js";
import { createMessage, history, pinned, toDto } from "../messages/routes.js";
import { leaveDmCall } from "../voice/calls.js";
import {
  areFriends,
  isUuid,
  NOT_FOUND,
  pair,
  requireDm,
  requireDmWritable,
  requireGroupDm,
  requireReachableUser,
  requireUser,
  userSelect,
} from "./access.js";

/** Participants oldest first: the order ownership passes on in, and the order clients list them in. */
const byJoin = [{ joinedAt: "asc" }, { userId: "asc" }] satisfies Prisma.DmParticipantOrderByWithRelationInput[];
const groupInclude = { participants: { orderBy: byJoin, select: { user: { select: userSelect } } } } satisfies Prisma.DmChannelInclude;
type GroupRow = Prisma.DmChannelGetPayload<{ include: typeof groupInclude }>;
type DmUser = { id: string; username: string };

/** A friend of `me` that `me` may pull into a group (unknown, blocked either way, not a friend: the same 404 as POST /dms). */
async function requireInvitable(me: string, userId: string) {
  const them = await requireReachableUser({ id: userId }, me);
  if (!(await areFriends(me, them.id))) throw NOT_FOUND;
  return them;
}

/** Serialises membership changes of one group (cap, owner hand-over, deleting the last one out). */
const lockDm = (tx: Prisma.TransactionClient, dmId: string) => tx.$queryRaw`SELECT 1 FROM "DmChannel" WHERE id = ${dmId}::uuid FOR UPDATE`;

export function dmRoutes(app: FastifyInstance) {
  // POST /dms and `dm:new` keep their pre-group shape (no `kind`: absent means PAIR); GET /dms items carry it.
  const dmDto = (id: string, user: DmUser, status: PresenceStatus | undefined) => ({ id, user: { ...user, ...presenceFields(status) } });
  const groupDto = (row: GroupRow, status: Map<string, PresenceStatus>) => ({
    id: row.id,
    kind: "GROUP" as const,
    name: row.name,
    ownerId: row.ownerId,
    participants: row.participants.map(({ user }) => ({ ...user, ...presenceFields(status.get(user.id)) })),
    lastMessageAt: row.lastMessageAt,
  });
  /** The group as `viewerId` sees it: presence is per viewer (invisible and blocked people look offline). */
  const groupFor = async (row: GroupRow, viewerId: string) => groupDto(row, await app.realtime.statusOf(viewerId, row.participants.map((p) => p.user.id)));
  const loadGroup = (id: string) => prisma.dmChannel.findUniqueOrThrow({ where: { id }, include: groupInclude });

  /** After a membership or name change: `dm:new` to the people just added, `dm:updated` to everyone else still in it. */
  async function announceGroup(row: GroupRow, added: string[] = []) {
    for (const { user } of row.participants) {
      app.realtime.emitToUsers([user.id], added.includes(user.id) ? "dm:new" : "dm:updated", await groupFor(row, user.id));
    }
  }

  /**
   * Takes `userId` out of the group under the row lock; `ownerId` (the remover) must still own it when given.
   * The owner leaving hands over to the longest-standing participant; the last one out deletes the group (messages
   * cascade). Returns false when they were not in it.
   */
  async function removeParticipant(dmId: string, userId: string, ownerId?: string) {
    const outcome = await prisma.$transaction(async (tx) => {
      await lockDm(tx, dmId);
      if (ownerId && !(await tx.dmChannel.count({ where: { id: dmId, ownerId } }))) throw new HttpError(403, "Only the owner can remove participants");
      const { count } = await tx.dmParticipant.deleteMany({ where: { dmChannelId: dmId, userId } });
      if (!count) return "missing" as const;
      const next = await tx.dmParticipant.findFirst({ where: { dmChannelId: dmId }, orderBy: byJoin });
      if (!next) {
        await tx.dmChannel.delete({ where: { id: dmId } });
        return "deleted" as const;
      }
      // An owner whose account is gone (ownerId set null) also hands over on the next departure.
      await tx.dmChannel.updateMany({ where: { id: dmId, OR: [{ ownerId: userId }, { ownerId: null }] }, data: { ownerId: next.userId } });
      return "left" as const;
    });
    if (outcome === "missing") return false;
    app.realtime.emitToUsers([userId], "dm:removed", { dmChannelId: dmId });
    await leaveDmCall(app, dmId, userId);
    if (outcome === "left") await announceGroup(await loadGroup(dmId));
    return true;
  }

  /**
   * Get-or-create. Unknown, blocked and not-a-friend all give the same 404 (nothing to tell them apart by);
   * `createMany ... skipDuplicates` is INSERT .. ON CONFLICT DO NOTHING on the unique pair, so concurrent calls
   * (even from the two sides) end with one channel. 201 on creation, 200 when it existed.
   */
  app.post("/dms", async (req, reply) => {
    const body = parse(openDmSchema, req.body, reply);
    if (!body) return;
    const them = await requireReachableUser({ id: body.userId }, req.userId);
    if (!(await areFriends(req.userId, them.id))) throw NOT_FOUND;
    const key = pair(req.userId, them.id);
    const { count } = await prisma.dmChannel.createMany({ data: [key], skipDuplicates: true });
    const dm = await prisma.dmChannel.findUniqueOrThrow({ where: { userLowId_userHighId: key } });
    const [theirs, mine, self] = await Promise.all([
      app.realtime.statusOf(req.userId, [them.id]),
      app.realtime.statusOf(them.id, [req.userId]), // as they may see me: an invisible caller stays offline
      requireUser({ id: req.userId }),
    ]);
    if (count) app.realtime.emitToUsers([them.id], "dm:new", dmDto(dm.id, self, mine.get(req.userId)));
    return reply.code(count ? 201 : 200).send(dmDto(dm.id, them, theirs.get(them.id)));
  });

  /**
   * A new group: the caller (owner) + 2..9 others, each an accepted friend of the caller with no block either way
   * (otherwise the same 404 as POST /dms, checked one by one so nothing tells which id failed). Always a new channel.
   */
  app.post("/dms/group", async (req, reply) => {
    const body = parse(createGroupDmSchema, req.body, reply);
    if (!body) return;
    if (body.userIds.includes(req.userId)) throw new HttpError(400, "Not allowed on yourself");
    for (const id of body.userIds) await requireInvitable(req.userId, id);
    const { id } = await prisma.dmChannel.create({
      data: {
        kind: "GROUP",
        ownerId: req.userId,
        name: body.name ?? null,
        participants: { create: [req.userId, ...body.userIds].map((userId) => ({ userId })) },
      },
      select: { id: true },
    });
    const row = await loadGroup(id);
    await announceGroup(row, body.userIds); // the creator's other devices get dm:updated
    return reply.code(201).send(await groupFor(row, req.userId));
  });

  /** Any participant adds one of THEIR friends (no block with the adder) while the group has room. */
  app.post<{ Params: { dmId: string } }>("/dms/:dmId/participants", async (req, reply) => {
    const { dm, participantIds } = await requireGroupDm(req.params.dmId, req.userId);
    const body = parse(addGroupDmParticipantSchema, req.body, reply);
    if (!body) return;
    if (participantIds.includes(body.userId)) throw new HttpError(409, "Already in the group");
    const them = await requireInvitable(req.userId, body.userId);
    await prisma.$transaction(async (tx) => {
      await lockDm(tx, dm.id);
      const present = await tx.dmParticipant.findMany({ where: { dmChannelId: dm.id }, select: { userId: true } });
      if (!present.some((p) => p.userId === req.userId)) throw NOT_FOUND; // left meanwhile
      if (present.some((p) => p.userId === them.id)) throw new HttpError(409, "Already in the group");
      if (present.length >= MAX_GROUP_DM) throw new HttpError(409, "Group is full");
      await tx.dmParticipant.create({ data: { dmChannelId: dm.id, userId: them.id } });
    });
    const row = await loadGroup(dm.id);
    await announceGroup(row, [them.id]);
    return groupFor(row, req.userId);
  });

  /** Leave a group; always allowed (no rate limit beyond `global`), the history is gone for the leaver at once. */
  app.delete<{ Params: { dmId: string } }>("/dms/:dmId/participants/me", async (req, reply) => {
    const { dm } = await requireGroupDm(req.params.dmId, req.userId);
    if (!(await removeParticipant(dm.id, req.userId))) throw NOT_FOUND; // left from another device meanwhile
    return reply.code(204).send();
  });

  /** The owner removes someone else (yourself: use leave). Not a participant / malformed: 404. */
  app.delete<{ Params: { dmId: string; userId: string } }>("/dms/:dmId/participants/:userId", async (req, reply) => {
    const { dm, participantIds } = await requireGroupDm(req.params.dmId, req.userId);
    if (dm.ownerId !== req.userId) throw new HttpError(403, "Only the owner can remove participants");
    if (req.params.userId === req.userId) throw new HttpError(400, "Not allowed on yourself");
    if (!isUuid(req.params.userId) || !participantIds.includes(req.params.userId)) throw NOT_FOUND;
    if (!(await removeParticipant(dm.id, req.params.userId, req.userId))) throw NOT_FOUND;
    return reply.code(204).send();
  });

  /** Rename (any participant; null or empty clears). Icons are not in this step. */
  app.patch<{ Params: { dmId: string } }>("/dms/:dmId", async (req, reply) => {
    const { dm } = await requireGroupDm(req.params.dmId, req.userId);
    const body = parse(updateGroupDmSchema, req.body, reply);
    if (!body) return;
    await prisma.dmChannel.update({ where: { id: dm.id }, data: { name: body.name } });
    const row = await loadGroup(dm.id);
    await announceGroup(row);
    return groupFor(row, req.userId);
  });

  // ponytail: loads all of the caller's DM channels, no paging; add a cursor on lastMessageAt if lists get long
  app.get("/dms", async (req) => {
    const me = req.userId;
    const rows = await prisma.dmChannel.findMany({
      where: { participants: { some: { userId: me } } },
      include: { userLow: { select: userSelect }, userHigh: { select: userSelect }, ...groupInclude },
    });
    // A block ends the friendship but keeps the DM: statusOf hides presence across it, in either direction.
    const status = await app.realtime.statusOf(me, [...new Set(rows.flatMap((r) => r.participants.map((p) => p.user.id)))]);
    const activity = (r: (typeof rows)[number]) => (r.lastMessageAt ?? r.createdAt).getTime();
    return rows
      .sort((a, b) => activity(b) - activity(a))
      .map((r) => {
        if (r.kind === "GROUP") return groupDto(r, status);
        const user = (r.userLowId === me ? r.userHigh : r.userLow)!;
        return { ...dmDto(r.id, user, status.get(user.id)), kind: "PAIR" as const, lastMessageAt: r.lastMessageAt };
      });
  });

  app.post<{ Params: { dmId: string } }>("/dms/:dmId/messages", async (req, reply) => {
    const { dm, participantIds } = await requireDmWritable(req.params.dmId, req.userId);
    const body = parse(messageBodySchema, req.body, reply);
    if (!body) return;
    const mentions = await resolveMentions(body.content, { dmParticipantIds: participantIds });
    const message = await toDto(
      await prisma.$transaction(async (tx) => {
        const created = await createMessage(tx, { dmChannelId: dm.id }, req.userId, body, mentions);
        await tx.dmChannel.update({ where: { id: dm.id }, data: { lastMessageAt: created.createdAt } });
        return created;
      }),
      app.storage,
    );
    app.realtime.emitDm(participantIds, "new", message);
    app.embeds.schedule(message.id, req.userId);
    return reply.code(201).send(message);
  });

  // History stays readable after an unfriend or block.
  app.get<{ Params: { dmId: string } }>("/dms/:dmId/messages", async (req, reply) => {
    const { dm } = await requireDm(req.params.dmId, req.userId);
    const q = parse(historyQuerySchema, req.query, reply);
    if (!q) return;
    return history({ dmChannelId: dm.id }, q, app.storage, req.userId);
  });

  // Readable after an unfriend or block, like the history.
  app.get<{ Params: { dmId: string } }>("/dms/:dmId/pins", async (req) => {
    const { dm } = await requireDm(req.params.dmId, req.userId);
    return pinned({ dmChannelId: dm.id }, app.storage, req.userId);
  });
}
