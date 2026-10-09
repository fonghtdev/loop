import argon2 from "argon2";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../http.js";
import {
  hashRefreshToken,
  newRefreshToken,
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

async function issueTokens(user: PublicUser, jwtSecret: string) {
  const refreshToken = newRefreshToken();
  await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return {
    user: toPublic(user),
    accessToken: await signAccessToken(user.id, jwtSecret),
    refreshToken,
  };
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

export async function refresh(refreshToken: string, jwtSecret: string) {
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashRefreshToken(refreshToken) },
    include: { user: true },
  });
  if (!session) throw INVALID_REFRESH;
  if (session.revokedAt) {
    // A rotated token came back: assume it was stolen and kill every session of the user.
    await prisma.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw INVALID_REFRESH;
  }
  if (session.expiresAt <= new Date()) throw INVALID_REFRESH;

  // Conditional update so two concurrent refreshes with the same token cannot both win.
  const { count } = await prisma.session.updateMany({
    where: { id: session.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) throw INVALID_REFRESH;
  return issueTokens(session.user, jwtSecret);
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
