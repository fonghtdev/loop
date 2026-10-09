import { SignJWT } from "jose";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";

const env = { databaseUrl: "", jwtSecret: "test-secret-test-secret-test-secret-1234", port: 0 };
const app = buildApp(env);

const creds = { email: "nam@example.com", username: "nam_01", password: "correct-horse" };

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
const me = (token?: string) =>
  app.inject({ method: "GET", url: "/me", headers: token ? { authorization: `Bearer ${token}` } : {} });
const register = async (c = creds) => (await post("/auth/register", c)).json();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE "Session", "User" CASCADE`;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("register", () => {
  it("creates the user and returns tokens without the hash", async () => {
    const res = await post("/auth/register", { ...creds, email: " Nam@Example.COM " });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toEqual({ id: expect.any(String), email: "nam@example.com", username: "nam_01" });
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
    const res = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect(res.statusCode).toBe(200);
    const second = res.json();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await me(second.accessToken)).statusCode).toBe(200);
    expect((await post("/auth/refresh", { refreshToken: second.refreshToken })).statusCode).toBe(200);
  });

  it("reusing a rotated token is 401 and revokes the newer session too", async () => {
    const first = await register();
    const second = (await post("/auth/refresh", { refreshToken: first.refreshToken })).json();
    expect((await post("/auth/refresh", { refreshToken: first.refreshToken })).statusCode).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: second.refreshToken })).statusCode).toBe(401);
  });

  it("401 for an expired session", async () => {
    const { refreshToken } = await register();
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post("/auth/refresh", { refreshToken })).statusCode).toBe(401);
  });

  it("401 for an unknown token", async () => {
    expect((await post("/auth/refresh", { refreshToken: "nope" })).statusCode).toBe(401);
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
