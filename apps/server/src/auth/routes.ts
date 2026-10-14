import type { FastifyInstance } from "fastify";
import { botLoginSchema, loginSchema, refreshTokenBodySchema, registerSchema } from "@loop/shared";
import { botLogin } from "../bots/routes.js";
import type { Env } from "../env.js";
import { parse, requireUser } from "../http.js";
import { findUser, login, logout, refresh, register } from "./service.js";

export function authRoutes(app: FastifyInstance, env: Env) {
  app.post("/auth/register", async (req, reply) => {
    const body = parse(registerSchema, req.body, reply);
    if (body) return reply.code(201).send(await register(body, env.jwtSecret));
  });

  app.post("/auth/login", async (req, reply) => {
    const body = parse(loginSchema, req.body, reply);
    if (body) return login(body, env.jwtSecret);
  });

  app.post("/auth/bot-login", async (req, reply) => {
    const body = parse(botLoginSchema, req.body, reply);
    if (body) return botLogin(body.token, env.jwtSecret);
  });

  app.post("/auth/refresh", async (req, reply) => {
    const body = parse(refreshTokenBodySchema, req.body, reply);
    if (body) return refresh(body.refreshToken, env.jwtSecret, env.refreshGraceMs);
  });

  app.post("/auth/logout", async (req, reply) => {
    const body = parse(refreshTokenBodySchema, req.body, reply);
    if (!body) return;
    await logout(body.refreshToken);
    return reply.code(204).send();
  });

  app.get("/me", { onRequest: requireUser(env.jwtSecret) }, async (req, reply) => {
    const user = await findUser(req.userId);
    if (!user) return reply.code(401).send({ error: "Unauthorized" });
    return user;
  });
}
