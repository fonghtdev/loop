import type { FastifyInstance } from "fastify";
import { blockRoutes } from "./blocks.js";
import { dmRoutes } from "./dms.js";
import { friendRoutes } from "./friends.js";

export function socialRoutes(app: FastifyInstance) {
  friendRoutes(app);
  blockRoutes(app);
  dmRoutes(app);
}
