import type { FastifyInstance } from "fastify";
import { setStatusSchema, type StatusPref } from "@loop/shared";
import { prisma } from "../db.js";
import { parse } from "../http.js";

const prefOf = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { statusPref: true } })).statusPref as StatusPref;

/** The caller's chosen status (people and bots alike). Others only ever see the effective one (presence:update). */
export function statusRoutes(app: FastifyInstance) {
  app.get("/me/status", async (req) => ({ status: await prefOf(req.userId) }));

  // ponytail: changes are ordered per user per instance only; two devices on different instances changing it in the
  // same instant may push live updates out of order (stored value and lists stay right; ceiling = a stale live status).
  app.put("/me/status", async (req, reply) => {
    const body = parse(setStatusSchema, req.body, reply);
    if (!body) return;
    await app.realtime.setStatus(req.userId, body.status);
    app.realtime.emitToUsers([req.userId], "me:status", { status: body.status });
    return { status: body.status };
  });
}
