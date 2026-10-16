import type { FastifyInstance } from "fastify";
import { gifSearchQuerySchema, gifTrendingQuerySchema } from "@loop/shared";
import type { Env } from "../env.js";
import { NOT_FOUND } from "../guilds/access.js";
import { parse } from "../http.js";
import { createGiphy } from "./giphy.js";

/** GIF search for the composer. Off (404) without `GIPHY_API_KEY`; `/gifs/config` tells the client which it is. */
export function gifRoutes(app: FastifyInstance, env: Env) {
  const load = env.giphyApiKey ? createGiphy(env.giphyApiKey, env.gifOverrides) : null;
  app.get("/gifs/config", async () => ({ enabled: load !== null }));

  for (const kind of ["search", "trending"] as const) {
    app.get(`/gifs/${kind}`, async (req, reply) => {
      if (!load) throw NOT_FOUND;
      const q = parse(kind === "search" ? gifSearchQuerySchema : gifTrendingQuerySchema, req.query, reply);
      if (!q) return;
      try {
        return await load(kind, q);
      } catch (err) {
        app.log.warn({ err: (err as Error).message.slice(0, 100) }, "gif provider failed"); // never the URL: it carries the key
        return reply.code(502).send({ error: "GIF service unavailable" });
      }
    });
  }
}
