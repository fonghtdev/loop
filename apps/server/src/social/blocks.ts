import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError } from "../http.js";
import { isUuid, NOT_FOUND, pair, requireUser, userSelect } from "./access.js";

// No event for the blocked user: they must not learn about it. A block also ends any friendship or pending request.
export function blockRoutes(app: FastifyInstance) {
  app.get("/blocks", async (req) => {
    const rows = await prisma.block.findMany({ where: { blockerId: req.userId }, include: { blocked: { select: userSelect } } });
    return rows.map((r) => r.blocked);
  });

  app.put<{ Params: { userId: string } }>("/blocks/:userId", async (req, reply) => {
    const target = await requireUser({ id: req.params.userId });
    if (target.id === req.userId) throw new HttpError(400, "Not allowed on yourself");
    await prisma.$transaction([
      prisma.block.createMany({ data: [{ blockerId: req.userId, blockedId: target.id }], skipDuplicates: true }),
      prisma.friendship.deleteMany({ where: pair(req.userId, target.id) }),
    ]);
    return reply.code(204).send();
  });

  app.delete<{ Params: { userId: string } }>("/blocks/:userId", async (req, reply) => {
    if (!isUuid(req.params.userId)) throw NOT_FOUND;
    await prisma.block.deleteMany({ where: { blockerId: req.userId, blockedId: req.params.userId } });
    return reply.code(204).send();
  });
}
