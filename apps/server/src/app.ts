import Fastify, { type FastifyError } from "fastify";
import { authRoutes } from "./auth/routes.js";
import type { Env } from "./env.js";
import { guildRoutes } from "./guilds/routes.js";
import { inviteRoutes } from "./guilds/invites.js";
import { HttpError, requireUser } from "./http.js";
import { messageRoutes } from "./messages/routes.js";
import { registerRealtime } from "./realtime.js";

export function buildApp(env: Env, logger = false) {
  const app = Fastify({ logger });
  app.decorateRequest("userId", "");
  // Clients often send `content-type: json` on bodyless POST/DELETE; Fastify rejects that by default.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body === "" ? undefined : JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }), undefined);
    }
  });
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    app.log.error({ err: err.message }, "unhandled error"); // message only: never log request bodies
    return reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: "Internal error" });
  });
  registerRealtime(app, env.jwtSecret);
  authRoutes(app, env);
  app.register(async (authed) => {
    authed.addHook("onRequest", requireUser(env.jwtSecret));
    guildRoutes(authed);
    inviteRoutes(authed);
    messageRoutes(authed);
  });
  return app;
}
