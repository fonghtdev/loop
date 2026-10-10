import argon2 from "argon2";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../http.js";
import {
  hashRefreshToken,
  newRefreshToken,
  REFRESH_GRACE_MS,
  REFRESH_TTL_MS,
  signAccessToken,
} from "./tokens.js";

export class AuthError extends HttpError {}

const INVALID_CREDENTIALS = new AuthError(401, "Invalid email or password");
const INVALID_REFRESH = new AuthError(401, "Invalid refresh token");

// Verified when the email is unknown so response time does not reveal which emails exist.
const dummyHash = argon2.hash("dummy-password-for-timing");

type PublicUser = { id: string; email: string; username: string };
const toPublic = ({ id, email, username }: PublicUser): PublicUser => ({ id, email, username });

const newSession = (userId: string, refreshToken: string) => ({
  userId,
  refreshTokenHash: hashRefreshToken(refreshToken),
  expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
});

const tokensFor = async (user: PublicUser, refreshToken: string, jwtSecret: string) => ({
  user: toPublic(user),
  accessToken: await signAccessToken(user.id, jwtSecret),
  refreshToken,
});
type Tokens = Awaited<ReturnType<typeof tokensFor>>;

async function issueTokens(user: PublicUser, jwtSecret: string) {
  const refreshToken = newRefreshToken();
  await prisma.session.create({ data: newSession(user.id, refreshToken) });
  return tokensFor(user, refreshToken, jwtSecret);
}

const LOST_RACE = Symbol("lost race");

/**
 * Replaces the session by a new one, but only while it is still active (conditional update, so of several
 * concurrent attempts exactly one wins). Returns null for the losers.
 */
async function rotate(sessionId: string, user: PublicUser, jwtSecret: string) {
  const refreshToken = newRefreshToken();
  try {
    await prisma.$transaction(async (tx) => {
      const next = await tx.session.create({ data: newSession(user.id, refreshToken) });
      const now = new Date();
      const { count } = await tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: now, rotatedAt: now, successorId: next.id },
      });
      if (count === 0) throw LOST_RACE; // rolls the new session back
    });
  } catch (e) {
    if (e === LOST_RACE) return null;
    throw e;
  }
  return tokensFor(user, refreshToken, jwtSecret);
}

export async function register(
  input: { email: string; username: string; password: string },
  jwtSecret: string,
) {
  const passwordHash = await argon2.hash(input.password);
  try {
    const user = await prisma.user.create({
      data: { email: input.email, username: input.username, passwordHash },
    });
    return await issueTokens(user, jwtSecret);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new AuthError(409, "Email or username already taken");
    }
    throw e;
  }
}

export async function login(input: { email: string; password: string }, jwtSecret: string) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const ok = await argon2.verify(user?.passwordHash ?? (await dummyHash), input.password);
  if (!user || !ok) throw INVALID_CREDENTIALS;
  return issueTokens(user, jwtSecret);
}

/**
 * Rotates the refresh token. A revoked token is theft (every session of the user is revoked) except within
 * the grace window after its rotation while the successor is still unused: then the client most likely lost
 * the rotation's response, so the successor is rotated in its place (the successor's token dies, one live
 * session remains). Trade-off: inside the window a thief holding the old token gets a pair too.
 */
export async function refresh(
  refreshToken: string,
  jwtSecret: string,
  graceMs = REFRESH_GRACE_MS,
): Promise<Tokens> {
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashRefreshToken(refreshToken) },
    include: { user: true },
  });
  if (!session) throw INVALID_REFRESH;
  if (session.revokedAt) {
    const { rotatedAt, successorId } = session;
    const inGrace = rotatedAt && successorId && Date.now() - rotatedAt.getTime() < graceMs;
    // Claiming the successor is the atomic "grace not used yet" check: a used successor is no longer active.
    const retried = inGrace ? await rotate(successorId, session.user, jwtSecret) : null;
    if (retried) return retried;
    await prisma.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw INVALID_REFRESH;
  }
  if (session.expiresAt <= new Date()) throw INVALID_REFRESH;
  // Lost to a concurrent refresh with the same token: judge it again, now as a reuse (grace or theft).
  return (await rotate(session.id, session.user, jwtSecret)) ?? refresh(refreshToken, jwtSecret, graceMs);
}

export async function logout(refreshToken: string) {
  await prisma.session.updateMany({
    where: { refreshTokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function findUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  return user && toPublic(user);
}
