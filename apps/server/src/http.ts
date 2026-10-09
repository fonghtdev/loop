import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { verifyAccessToken } from "./auth/tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export function parse<T extends z.ZodTypeAny>(schema: T, body: unknown, reply: FastifyReply) {
  const result = schema.safeParse(body);
  if (!result.success) {
    reply.code(400).send({ error: "Invalid request", issues: result.error.issues });
    return null;
  }
  return result.data as z.output<T>;
}

/** onRequest hook: verifies the bearer access token and sets `req.userId`. */
export const requireUser = (jwtSecret: string) => async (req: FastifyRequest) => {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const userId = token && (await verifyAccessToken(token, jwtSecret));
  if (!userId) throw new HttpError(401, "Unauthorized");
  req.userId = userId;
};
