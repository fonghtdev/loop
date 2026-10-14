import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { prisma } from "../db.js";

const ACCESS_TTL = "15m";
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// How long a rotated refresh token may be retried when the client lost the rotation's response.
export const REFRESH_GRACE_MS = 20 * 1000;

const key = (secret: string) => new TextEncoder().encode(secret);

/** `botTokenHash`: a bot's token, bound to the bot token it was issued for (see verifyAccessToken). */
export function signAccessToken(userId: string, secret: string, botTokenHash?: string) {
  return new SignJWT(botTokenHash ? { bot: botTokenHash } : {})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(key(secret));
}

/** Returns the user id, or null when the token is invalid or expired. */
export async function verifyAccessToken(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    // A bot's access token dies with its bot token (rotation, deletion): checked against the DB on every use.
    // ponytail: one query per bot request/handshake; upgrade = a short cache with pub/sub invalidation
    if (payload.bot !== undefined && !(await isLiveBotToken(payload.sub, payload.bot))) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

const isLiveBotToken = async (userId: string, hash: unknown) =>
  typeof hash === "string" &&
  (await prisma.user.count({ where: { id: userId, isBot: true, deletedAt: null, botTokenHash: hash } })) > 0;

export const newRefreshToken = () => randomBytes(32).toString("base64url");

// ponytail: plain SHA-256 is fine because the token is 256 bits of randomness (no brute force)
export const hashRefreshToken = (token: string) => createHash("sha256").update(token).digest("hex");
