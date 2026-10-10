import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { authRoutes } from "./auth/routes.js";
import type { Env } from "./env.js";
import { attachmentRoutes } from "./attachments/routes.js";
import { guildRoutes } from "./guilds/routes.js";
import { inviteRoutes } from "./guilds/invites.js";
import { roleRoutes } from "./guilds/roles.js";
import { HttpError, requireUser } from "./http.js";
import { messageRoutes } from "./messages/routes.js";
import { registerRealtime } from "./realtime.js";
import { socialRoutes } from "./social/routes.js";
import { createStorage } from "./storage.js";
import { callRoutes } from "./voice/calls.js";
import { createVoice } from "./voice/enforce.js";
import { createLivekit } from "./voice/livekit.js";
import { voiceRoutes } from "./voice/routes.js";
import { webhookRoutes } from "./voice/webhook.js";

export function buildApp(env: Env, logger: FastifyServerOptions["logger"] = false) {
  const app = Fastify({ logger });
  app.decorateRequest("userId", "");
  // Bearer tokens, no cookies: credentials stay off. An origin outside the list gets no CORS headers.
  app.register(cors, { origin: env.corsOrigins, allowedHeaders: ["Authorization", "Content-Type"], methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
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
  app.decorate("storage", createStorage(env.s3));
  app.addHook("onClose", async () => app.storage.close());
  app.decorate("livekit", createLivekit(env.livekit));
  app.decorate("voice", createVoice(app.livekit, app.log));
  registerRealtime(app, env.jwtSecret, env.redisUrl, app.voice, env.corsOrigins);
  authRoutes(app, env);
  webhookRoutes(app); // authenticated by LiveKit's signature, not by a user token
  app.register(async (authed) => {
    authed.addHook("onRequest", requireUser(env.jwtSecret));
    guildRoutes(authed);
    inviteRoutes(authed);
    roleRoutes(authed);
    messageRoutes(authed);
    attachmentRoutes(authed);
    socialRoutes(authed);
    voiceRoutes(authed);
    callRoutes(authed);
  });
  return app;
}
