import type { FastifyInstance } from "fastify";
import { friendRequestSchema } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { endDmCall } from "../voice/calls.js";
import { isUuid, NOT_FOUND, pair, requireReachableUser, requireUser, userSelect } from "./access.js";

type PublicUser = { id: string; username: string };

/** Turns a PENDING request from `requesterId` to `me` into a friendship; false when there is none. */
async function accept(me: string, requesterId: string) {
  const { count } = await prisma.friendship.updateMany({
    where: { ...pair(me, requesterId), status: "PENDING", requesterId },
    data: { status: "ACCEPTED" },
  });
  return count > 0;
}

export function friendRoutes(app: FastifyInstance) {
  const notifyAccepted = (a: PublicUser, b: PublicUser) => {
    app.realtime.emitToUsers([a.id], "friend:accepted", { user: b });
    app.realtime.emitToUsers([b.id], "friend:accepted", { user: a });
  };

  app.get("/friends", async (req) => {
    const me = req.userId;
    const rows = await prisma.friendship.findMany({
      where: { OR: [{ userLowId: me }, { userHighId: me }] },
      include: { userLow: { select: userSelect }, userHigh: { select: userSelect } },
    });
    const withOther = rows.map((r) => ({ ...r, other: r.userLowId === me ? r.userHigh : r.userLow }));
    const accepted = withOther.filter((r) => r.status === "ACCEPTED").map((r) => r.other);
    const online = await app.realtime.onlineIds(accepted.map((u) => u.id));
    const pending = withOther.filter((r) => r.status === "PENDING");
    return {
      friends: accepted.map((u) => ({ ...u, online: online.has(u.id) })),
      incoming: pending.filter((r) => r.requesterId !== me).map((r) => r.other),
      outgoing: pending.filter((r) => r.requesterId === me).map((r) => r.other),
    };
  });

  app.post("/friends/requests", async (req, reply) => {
    const body = parse(friendRequestSchema, req.body, reply);
    if (!body) return;
    const me = req.userId;
    const them = await requireReachableUser({ username: body.username }, me);
    // Bots have no friends, so they never DM or DM-call either (both need a friendship).
    if (await prisma.user.count({ where: { id: { in: [me, them.id] }, isBot: true } })) {
      throw new HttpError(403, "Bots cannot have friends");
    }
    const self = await requireUser({ id: me });
    const { count } = await prisma.friendship.createMany({
      data: [{ ...pair(me, them.id), requesterId: me, status: "PENDING" }],
      skipDuplicates: true, // a concurrent mutual request lands here instead of failing
    });
    if (count) {
      app.realtime.emitToUsers([them.id], "friend:request", { from: self });
      return reply.code(201).send({ status: "PENDING", user: them });
    }
    // A row for this pair exists: it is their request to me (accept it), or already friends / my own request.
    if (!(await accept(me, them.id))) throw new HttpError(409, "Already friends or request already sent");
    notifyAccepted(self, them);
    return { status: "ACCEPTED", user: them };
  });

  app.post<{ Params: { userId: string } }>("/friends/requests/:userId/accept", async (req) => {
    const requester = await requireUser({ id: req.params.userId });
    if (!(await accept(req.userId, requester.id))) throw NOT_FOUND;
    notifyAccepted(await requireUser({ id: req.userId }), requester);
    return { status: "ACCEPTED", user: requester };
  });

  /** Decline (as the addressee) or cancel (as the requester). */
  app.delete<{ Params: { userId: string } }>("/friends/requests/:userId", async (req, reply) => {
    if (!isUuid(req.params.userId)) throw NOT_FOUND;
    const { count } = await prisma.friendship.deleteMany({ where: { ...pair(req.userId, req.params.userId), status: "PENDING" } });
    if (!count) throw NOT_FOUND;
    return reply.code(204).send();
  });

  app.delete<{ Params: { userId: string } }>("/friends/:userId", async (req, reply) => {
    if (!isUuid(req.params.userId)) throw NOT_FOUND;
    const { count } = await prisma.friendship.deleteMany({ where: { ...pair(req.userId, req.params.userId), status: "ACCEPTED" } });
    if (!count) throw NOT_FOUND;
    app.realtime.emitToUsers([req.params.userId], "friend:removed", { userId: req.userId });
    await endDmCall(app, req.userId, req.params.userId);
    return reply.code(204).send();
  });
}
