import type { FastifyInstance } from "fastify";
import { historyQuerySchema, messageBodySchema, openDmSchema } from "@loop/shared";
import { prisma } from "../db.js";
import { parse } from "../http.js";
import { createMessage, history, toDto } from "../messages/routes.js";
import { areFriends, NOT_FOUND, otherOf, pair, requireDm, requireFriendsUnblocked, requireReachableUser, requireUser, userSelect } from "./access.js";

export function dmRoutes(app: FastifyInstance) {
  const dmDto = (id: string, user: { id: string; username: string }, online: boolean) => ({ id, user: { ...user, online } });

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
    const [online, self] = await Promise.all([app.realtime.onlineIds([them.id]), requireUser({ id: req.userId })]);
    if (count) app.realtime.emitToUsers([them.id], "dm:new", dmDto(dm.id, self, true));
    return reply.code(count ? 201 : 200).send(dmDto(dm.id, them, online.has(them.id)));
  });

  // ponytail: loads all of the caller's DM channels, no paging; add a cursor on lastMessageAt if lists get long
  app.get("/dms", async (req) => {
    const me = req.userId;
    const rows = await prisma.dmChannel.findMany({
      where: { OR: [{ userLowId: me }, { userHighId: me }] },
      include: { userLow: { select: userSelect }, userHigh: { select: userSelect } },
    });
    const online = await app.realtime.onlineIds(rows.map((r) => otherOf(r, me)));
    const activity = (r: (typeof rows)[number]) => (r.lastMessageAt ?? r.createdAt).getTime();
    return rows
      .sort((a, b) => activity(b) - activity(a))
      .map((r) => {
        const user = r.userLowId === me ? r.userHigh : r.userLow;
        return { ...dmDto(r.id, user, online.has(user.id)), lastMessageAt: r.lastMessageAt };
      });
  });

  app.post<{ Params: { dmId: string } }>("/dms/:dmId/messages", async (req, reply) => {
    const { dm, otherId } = await requireDm(req.params.dmId, req.userId);
    await requireFriendsUnblocked(req.userId, otherId);
    const body = parse(messageBodySchema, req.body, reply);
    if (!body) return;
    const message = await toDto(
      await prisma.$transaction(async (tx) => {
        const created = await createMessage(tx, { dmChannelId: dm.id }, req.userId, body);
        await tx.dmChannel.update({ where: { id: dm.id }, data: { lastMessageAt: created.createdAt } });
        return created;
      }),
      app.storage,
    );
    app.realtime.emitDm(dm, "new", message);
    return reply.code(201).send(message);
  });

  // History stays readable after an unfriend or block.
  app.get<{ Params: { dmId: string } }>("/dms/:dmId/messages", async (req, reply) => {
    const { dm } = await requireDm(req.params.dmId, req.userId);
    const q = parse(historyQuerySchema, req.query, reply);
    if (!q) return;
    return history({ dmChannelId: dm.id }, q, app.storage);
  });
}
