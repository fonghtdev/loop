import { SignJWT } from "jose";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { env } from "../../test/helpers.js";
import { hashRefreshToken, REFRESH_GRACE_MS } from "./tokens.js";

const app = buildApp(env);
const noGrace = buildApp({ ...env, refreshGraceMs: 0 });

const creds = { email: "nam@example.com", username: "nam_01", password: "correct-horse" };

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
const me = (token?: string) =>
  app.inject({ method: "GET", url: "/me", headers: token ? { authorization: `Bearer ${token}` } : {} });
const register = async (c = creds) => (await post("/auth/register", c)).json();
const refresh = (refreshToken: string, via = app) =>
  via.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
const activeSessions = () => prisma.session.count({ where: { revokedAt: null } });

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE "Session", "User" CASCADE`;
});
afterAll(async () => {
  await app.close();
  await noGrace.close();
  await prisma.$disconnect();
});

describe("register", () => {
  it("creates the user and returns tokens without the hash", async () => {
    const res = await post("/auth/register", { ...creds, email: " Nam@Example.COM " });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toEqual({ id: expect.any(String), email: "nam@example.com", username: "nam_01", displayName: null, avatarHash: null });
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(res.body).not.toMatch(/passwordHash|argon2/);
  });

  it("409 on duplicate email", async () => {
    await register();
    const res = await post("/auth/register", { ...creds, username: "other" });
    expect(res.statusCode).toBe(409);
  });

  it("409 on duplicate username", async () => {
    await register();
    const res = await post("/auth/register", { ...creds, email: "other@example.com" });
    expect(res.statusCode).toBe(409);
  });

  it.each([
    ["bad email", { ...creds, email: "nope" }],
    ["short password", { ...creds, password: "short" }],
    ["bad username", { ...creds, username: "Bad Name" }],
    ["missing body fields", {}],
  ])("400 on %s", async (_name, body) => {
    expect((await post("/auth/register", body)).statusCode).toBe(400);
  });
});

describe("login", () => {
  it("returns tokens for correct credentials", async () => {
    await register();
    const res = await post("/auth/login", { email: creds.email, password: creds.password });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe("nam_01");
    expect(res.body).not.toMatch(/passwordHash/);
  });

  it("wrong password and unknown email give the same 401 body", async () => {
    await register();
    const wrong = await post("/auth/login", { email: creds.email, password: "wrong-password" });
    const unknown = await post("/auth/login", { email: "ghost@example.com", password: "wrong-password" });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
  });
});

describe("/me", () => {
  it("returns the user for a valid token", async () => {
    const { accessToken, user } = await register();
    const res = await me(accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(user);
  });

  it("401 without token, with garbage, and with an expired token", async () => {
    const { user } = await register();
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(env.jwtSecret));
    expect((await me()).statusCode).toBe(401);
    expect((await me("garbage")).statusCode).toBe(401);
    expect((await me(expired)).statusCode).toBe(401);
  });
});

describe("refresh", () => {
  it("rotates: new tokens work", async () => {
    const first = await register();
    const res = await refresh(first.refreshToken);
    expect(res.statusCode).toBe(200);
    const second = res.json();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await me(second.accessToken)).statusCode).toBe(200);
    expect((await refresh(second.refreshToken)).statusCode).toBe(200);
  });

  it("reusing a rotated token is 401 and revokes the newer session too (no grace window)", async () => {
    const first = await register();
    const second = (await refresh(first.refreshToken, noGrace)).json();
    expect((await refresh(first.refreshToken, noGrace)).statusCode).toBe(401);
    expect((await refresh(second.refreshToken, noGrace)).statusCode).toBe(401);
  });

  it("401 for an expired session, other sessions untouched", async () => {
    const { refreshToken } = await register();
    const other = (await post("/auth/login", creds)).json();
    await prisma.session.update({
      where: { refreshTokenHash: hashRefreshToken(refreshToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await refresh(refreshToken)).statusCode).toBe(401);
    expect((await refresh(other.refreshToken)).statusCode).toBe(200);
  });

  it("401 for an unknown token, other sessions untouched", async () => {
    const { refreshToken } = await register();
    expect((await refresh("nope")).statusCode).toBe(401);
    expect((await refresh(refreshToken)).statusCode).toBe(200);
  });
});

describe("refresh grace window (the client lost the rotation's response)", () => {
  /** Registers and rotates once; the response of that rotation is "lost": only `lost` knows the successor. */
  const rotatedOnce = async () => {
    const old = (await register()).refreshToken as string;
    const lost = (await refresh(old)).json();
    return { old, lost };
  };

  it("retrying the old token inside the window gives a working pair and kills the lost one", async () => {
    const { old, lost } = await rotatedOnce();
    const res = await refresh(old);
    expect(res.statusCode).toBe(200);
    const retried = res.json();
    expect((await me(retried.accessToken)).statusCode).toBe(200);
    expect(await activeSessions()).toBe(1);
    const lostSession = await prisma.session.findUniqueOrThrow({ where: { refreshTokenHash: hashRefreshToken(lost.refreshToken) } });
    expect(lostSession.revokedAt).not.toBeNull();
  });

  it("the retried pair rotates normally", async () => {
    const { old } = await rotatedOnce();
    const retried = (await refresh(old)).json();
    expect((await refresh(retried.refreshToken)).statusCode).toBe(200);
    expect(await activeSessions()).toBe(1);
  });

  it("a second reuse of the same old token (grace used) is 401 and revokes everything", async () => {
    const { old } = await rotatedOnce();
    const retried = (await refresh(old)).json();
    expect((await refresh(old)).statusCode).toBe(401);
    expect(await activeSessions()).toBe(0);
    expect((await refresh(retried.refreshToken)).statusCode).toBe(401);
  });

  it("reuse after the successor was used (the client did get it) is 401 and revokes everything", async () => {
    const { old, lost } = await rotatedOnce();
    const next = (await refresh(lost.refreshToken)).json();
    expect((await refresh(old)).statusCode).toBe(401);
    expect(await activeSessions()).toBe(0);
    expect((await refresh(next.refreshToken)).statusCode).toBe(401);
  });

  it("reuse outside the window is 401 and revokes everything", async () => {
    const { old, lost } = await rotatedOnce();
    await prisma.session.update({
      where: { refreshTokenHash: hashRefreshToken(old) },
      data: { rotatedAt: new Date(Date.now() - REFRESH_GRACE_MS - 1000) },
    });
    expect((await refresh(old)).statusCode).toBe(401);
    expect(await activeSessions()).toBe(0);
    expect((await refresh(lost.refreshToken)).statusCode).toBe(401);
  });

  it("reuse of a logged-out token is 401 and revokes every session (unchanged behaviour)", async () => {
    const { refreshToken } = await register();
    const other = (await post("/auth/login", creds)).json();
    expect((await post("/auth/logout", { refreshToken })).statusCode).toBe(204);
    expect((await refresh(refreshToken)).statusCode).toBe(401);
    expect(await activeSessions()).toBe(0);
    expect((await refresh(other.refreshToken)).statusCode).toBe(401);
  });

  it("two concurrent refreshes with one active token (retry raced the original): both 200, one live session", async () => {
    const { refreshToken } = await register();
    const res = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);
    expect(res.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await activeSessions()).toBe(1);
    // The loser was judged as a reuse inside the window: its pair is the live one, the winner's was rotated.
    const live = await Promise.all(
      res.map((r) => prisma.session.count({ where: { refreshTokenHash: hashRefreshToken(r.json().refreshToken), revokedAt: null } })),
    );
    expect(live.sort()).toEqual([0, 1]);
  });

  it("five concurrent refreshes with one active token: rotation + grace win, the rest is theft", async () => {
    const { refreshToken } = await register();
    const res = await Promise.all(Array.from({ length: 5 }, () => refresh(refreshToken)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 200, 401, 401, 401]);
    expect(await activeSessions()).toBe(0);
  });

  it("five concurrent reuses of a rotated token: exactly one gets the grace, the rest is theft", async () => {
    const { old } = await rotatedOnce();
    const res = await Promise.all(Array.from({ length: 5 }, () => refresh(old)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 401, 401, 401, 401]);
    expect(await activeSessions()).toBe(0);
  });
});

describe("logout", () => {
  it("revokes the session, idempotently", async () => {
    const { refreshToken } = await register();
    expect((await post("/auth/logout", { refreshToken })).statusCode).toBe(204);
    expect((await post("/auth/logout", { refreshToken })).statusCode).toBe(204);
    expect((await post("/auth/refresh", { refreshToken })).statusCode).toBe(401);
  });
});
