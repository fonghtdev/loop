import type { FastifyInstance } from "fastify";
import { prisma } from "./db.js";

const PROBE_MS = 1000;

const within = <T>(work: Promise<T>) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_MS).unref())]);

// An object so tests can make one dependency fail (Prisma's client cannot be spied on and restored).
export const probes = {
  postgres: () => prisma.$queryRaw`SELECT 1`,
  redis: (app: FastifyInstance) => app.realtime.ping(),
};

/** Unauthenticated liveness probe: 200 only when Postgres and Redis both answer within a second. No details leak. */
export function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    try {
      await within(Promise.all([probes.postgres(), probes.redis(app)]));
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
}
