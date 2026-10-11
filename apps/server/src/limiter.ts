import { createHash } from "node:crypto";
import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import type { Env } from "./env.js";
import { HttpError } from "./http.js";
import { EXEMPT, POLICIES, type Policy, type PolicyName, ROUTES } from "./rate-limits.js";

export type Limits = {
  /** Counts one hit; 0 = allowed, else seconds until the key may try again. Fails open when the store errors. */
  hit(name: PolicyName, subject: string): Promise<number>;
  /** Client address of a Socket.IO handshake, with the same proxy trust as HTTP. */
  socketIp(headers: Record<string, unknown>, address: string): string;
  /** A fresh in-memory counter for one socket: true while under `socket-subscribe`. */
  socketBudget(): () => boolean;
};

const ipOf = (req: FastifyRequest) => normalizeIP(req.ip);
const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

function subjectOf(by: Policy["by"], req: FastifyRequest) {
  if (by === "user") return req.userId || ipOf(req);
  if (by === "ip+email") {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return `${ipOf(req)}|${digest(typeof email === "string" ? email.trim().toLowerCase() : "")}`;
  }
  return ipOf(req);
}

const off: Limits = { hit: async () => 0, socketIp: (_h, address) => address, socketBudget: () => () => true };

/**
 * Registers the limiter: every route is judged against ROUTES / EXEMPT (even with limiting off, so CI catches an
 * undecided route), and limiting adds one preValidation hook per route (after auth, so `req.userId` is known).
 * Counting is @fastify/rate-limit's Redis script, so budgets hold across server instances.
 */
export function registerLimiter(app: FastifyInstance, env: Env): Limits {
  const policies = (name: PolicyName): Policy => ({ ...POLICIES[name], ...env.rateLimitOverrides?.policies?.[name] });
  let limits = off;
  if (env.rateLimit) {
    // Commands wait for the connection at boot but give up after 500 ms when Redis is down (then: fail open).
    const redis = env.rateLimitOverrides?.redis ?? new Redis(env.redisUrl, { commandTimeout: 500 });
    redis.on("error", () => {}); // outages are logged per failed check below
    app.addHook("onClose", async () => void (await redis.quit().catch(() => {})));
    app.register(rateLimit, { global: false, redis, nameSpace: env.rateLimitOverrides?.namespace ?? "rl:" });
    const checks = new Map<PolicyName, ReturnType<FastifyInstance["createRateLimit"]>>();
    const trust = env.trustProxy;
    limits = {
      async hit(name, subject) {
        const { max, windowMs } = policies(name);
        let check = checks.get(name);
        if (!check) {
          check = app.createRateLimit({ max, timeWindow: windowMs, keyGenerator: (r) => `${name}:${(r as unknown as { subject: string }).subject}` });
          checks.set(name, check);
        }
        try {
          const res = await check({ subject, routeOptions: { config: {} } } as unknown as FastifyRequest);
          return !res.isAllowed && res.isExceeded ? Math.max(1, res.ttlInSeconds) : 0;
        } catch (e) {
          // ponytail: fails open (an outage must not take auth down) and costs up to 500 ms per request while Redis is
          // unreachable; upgrade = a circuit breaker that skips the store for a few seconds after a failure.
          app.log.error({ err: String((e as Error).message) }, "rate limit store unavailable, letting the request through");
          return 0;
        }
      },
      socketIp(headers, address) {
        if (!trust) return address; // never read a client-supplied header unless a proxy is declared
        const chain = [...String(headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean), address];
        return normalizeIP(chain[trust === true ? 0 : Math.max(0, chain.length - 1 - trust)].slice(0, 64));
      },
      socketBudget() {
        const { max, windowMs } = policies("socket-subscribe");
        let count = 0;
        let resetAt = 0;
        return () => {
          if (Date.now() >= resetAt) [count, resetAt] = [0, Date.now() + windowMs];
          return ++count <= max;
        };
      },
    };
  }

  const guard = (names: PolicyName[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    for (const name of names) {
      const retryAfter = await limits.hit(name, subjectOf(policies(name).by, req));
      if (!retryAfter) continue;
      reply.header("retry-after", retryAfter); // which key tripped is deliberately not said
      throw new HttpError(429, "Too many requests");
    }
  };

  app.addHook("onRoute", (route) => {
    const methods = [route.method].flat();
    if (methods.length > 1) throw new Error(`${route.url}: one method per route, so each gets its own rate-limit decision`);
    if (methods[0] === "OPTIONS") return; // CORS preflight is answered before any route hook
    const id = `${methods[0] === "HEAD" ? "GET" : methods[0]} ${route.url}`;
    if (id in EXEMPT) return;
    if (!(id in ROUTES)) throw new Error(`Route ${id} has no rate-limit decision: add it to ROUTES or EXEMPT in src/rate-limits.ts`);
    if (env.rateLimit) route.preValidation = [...[route.preValidation ?? []].flat(), guard([...ROUTES[id], "global"])];
  });
  return limits;
}
