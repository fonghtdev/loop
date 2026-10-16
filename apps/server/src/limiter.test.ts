import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { prisma } from "./db.js";
import type { Env } from "./env.js";
import { EXEMPT, POLICIES, type PolicyOverrides, ROUTES } from "./rate-limits.js";
import { befriend, caller, env, guildWith, resetDb, signUp } from "../test/helpers.js";
import { connect as connectTo, listen, settle, until } from "../test/sockets.js";

/**
 * Real Redis, real app. The shared test env has limiting off (the suite signs up dozens of users from one address);
 * here a fresh app turns it on with small numbers and its own key namespace, so nothing leaks between tests.
 */
const plain = buildApp(env);
const apps: ReturnType<typeof buildApp>[] = [];
const limited = (policies: PolicyOverrides, extra: Partial<Env> = {}) => {
  const app = buildApp({ ...env, rateLimit: true, trustProxy: true, rateLimitOverrides: { policies, namespace: `${randomUUID()}:` }, ...extra });
  apps.push(app);
  return app;
};
const as = (ip: string) => ({ "x-forwarded-for": ip });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const login = (app: ReturnType<typeof buildApp>, email = "a@example.com", headers = {}) =>
  app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "whatever-password" }, headers });
const statuses = async (n: number, f: (i: number) => Promise<{ statusCode: number }>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await f(i)).statusCode);
  return out;
};
const loose = { max: 1000, windowMs: 60_000 };

beforeEach(resetDb);
afterEach(async () => void (await Promise.all(apps.splice(0).map((a) => a.close()))));
afterAll(async () => {
  await plain.close();
  await prisma.$disconnect();
});

describe("login", () => {
  it("answers 429 with the error shape and a sane Retry-After once the IP budget is spent, per IP, and the window resets", async () => {
    const app = limited({ "login-ip": { max: 3, windowMs: 1000 } });
    expect(await statuses(3, () => login(app))).toEqual([401, 401, 401]);
    const res = await login(app);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "Too many requests" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(1);
    expect((await login(app, "a@example.com", as("203.0.113.9"))).statusCode).toBe(401);
    await sleep(1100);
    expect((await login(app)).statusCode).toBe(401);
  });

  it("keys the second budget on (IP, email): the same email from another IP, or another email, is not locked out", async () => {
    const app = limited({ "login-email": { max: 2, windowMs: 60_000 } });
    expect(await statuses(2, () => login(app, "Victim@Example.com"))).toEqual([401, 401]);
    expect((await login(app, " victim@example.com ")).statusCode, "same pair, case/space folded").toBe(429);
    expect((await login(app, "victim@example.com", as("203.0.113.9"))).statusCode, "the real owner elsewhere").toBe(401);
    expect((await login(app, "other@example.com")).statusCode, "same IP, other email").toBe(401);
  });

  it("does not reveal which key tripped", async () => {
    const byIp = await login(limited({ "login-ip": { max: 0, windowMs: 1000 } }));
    const byPair = await login(limited({ "login-email": { max: 0, windowMs: 1000 } }));
    expect(byIp.json()).toEqual(byPair.json());
  });
});

describe("other unauthenticated routes", () => {
  it("register", async () => {
    const app = limited({ register: { max: 2, windowMs: 60_000 } });
    const register = (i: number) =>
      app.inject({ method: "POST", url: "/auth/register", payload: { email: `r${i}@example.com`, username: `r${i}`, password: "correct-horse" } });
    expect(await statuses(3, register)).toEqual([201, 201, 429]);
  });

  it("refresh", async () => {
    const app = limited({ refresh: { max: 2, windowMs: 60_000 } });
    const refresh = () => app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: "x".repeat(40) } });
    expect(await statuses(3, refresh)).toEqual([401, 401, 429]);
  });
});

describe("authenticated routes are keyed by user", () => {
  it("message send: two users on one IP have separate budgets; the same user on two IPs shares one", async () => {
    const [a, b] = await Promise.all([signUp(plain, "alice"), signUp(plain, "bob")]);
    const { general } = await guildWith(plain, a, b);
    const app = limited({ "message-send": { max: 3, windowMs: 60_000 }, "message-burst": loose });
    const call = caller(app);
    const send = (token: string, ip: string) =>
      app.inject({ method: "POST", url: `/channels/${general.id}/messages`, payload: { content: "hi" }, headers: { authorization: `Bearer ${token}`, ...as(ip) } });
    expect(await statuses(3, () => send(a.token, "198.51.100.1"))).toEqual([201, 201, 201]);
    expect((await send(a.token, "198.51.100.1")).statusCode).toBe(429);
    expect((await send(a.token, "198.51.100.2")).statusCode, "same user, new IP").toBe(429);
    expect((await send(b.token, "198.51.100.1")).statusCode, "other user, same IP").toBe(201);
    expect((await call("GET", `/channels/${general.id}/messages`, a.token)).statusCode, "reads are not sends").toBe(200);
  });

  it("message burst allowance trips before the per-minute budget and clears with its short window", async () => {
    const a = await signUp(plain, "alice");
    const { general } = await guildWith(plain, a);
    const app = limited({ "message-burst": { max: 2, windowMs: 1000 }, "message-send": loose });
    const send = () => caller(app)("POST", `/channels/${general.id}/messages`, a.token, { content: "hi" });
    expect(await statuses(3, send)).toEqual([201, 201, 429]);
    await sleep(1100);
    expect((await send()).statusCode).toBe(201);
  });

  it.each([
    ["friend requests", "friend-request", "POST", () => "/friends/requests", { username: "nobody" }, 404],
    ["guild creation", "guild-create", "POST", () => "/guilds", { name: "HQ" }, 201],
    ["invite join", "invite-join", "POST", () => "/invites/nope/join", undefined, 404],
    ["attachment create", "attachment-create", "POST", () => "/attachments", {}, 400],
    ["voice token", "voice-token", "POST", () => `/channels/${randomUUID()}/voice/token`, undefined, 404],
    ["voice move", "voice-move", "POST", () => `/channels/${randomUUID()}/voice/move`, { userId: randomUUID() }, 404],
    ["reaction add", "reaction-change", "PUT", () => `/messages/${randomUUID()}/reactions/${encodeURIComponent("👍")}`, undefined, 404],
    ["reaction remove", "reaction-change", "DELETE", () => `/messages/${randomUUID()}/reactions/${encodeURIComponent("👍")}`, undefined, 404],
    ["read state", "read-state", "PUT", () => `/channels/${randomUUID()}/read`, { seq: "1" }, 404],
    ["message search", "message-search", "GET", () => `/guilds/${randomUUID()}/messages/search?q=hi`, undefined, 404],
    ["status change", "status-set", "PUT", () => "/me/status", { status: "dnd" }, 200],
    ["profile update", "profile-update", "PATCH", () => "/me/profile", { bio: "hi" }, 200],
    ["image upload", "image-upload", "POST", () => "/me/avatar/upload", { contentType: "image/png", size: 10 }, 201],
  ] as const)("%s", async (_, policy, method, url, body, firstStatus) => {
    const u = await signUp(plain, "alice");
    const app = limited({ [policy]: { max: 1, windowMs: 60_000 } });
    const call = caller(app);
    expect((await call(method, url(), u.token, body)).statusCode).toBe(firstStatus);
    const res = await call(method, url(), u.token, body);
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    const other = await signUp(plain, "bob");
    expect((await call(method, url(), other.token, body)).statusCode, "another user is unaffected").toBe(firstStatus);
  });

  it("public image reads are keyed by IP (no token to key on)", async () => {
    const app = limited({ "image-read": { max: 2, windowMs: 60_000 } });
    const send = () => app.inject({ method: "GET", url: `/users/${randomUUID()}/avatar` });
    expect(await statuses(3, send)).toEqual([404, 404, 429]);
  });

  it("the global budget covers every route, including reads", async () => {
    const u = await signUp(plain, "alice");
    const app = limited({ global: { max: 2, windowMs: 60_000 } });
    expect(await statuses(3, () => caller(app)("GET", "/me", u.token))).toEqual([200, 200, 429]);
  });
});

describe("exemptions", () => {
  it("the LiveKit webhook is never throttled", async () => {
    expect(Object.keys(EXEMPT)).toEqual(["GET /health", "POST /livekit/webhook"]);
    const app = limited({ global: { max: 1, windowMs: 60_000 } });
    const hook = () => app.inject({ method: "POST", url: "/livekit/webhook", headers: { "content-type": "application/webhook+json" }, payload: "{}" });
    expect(new Set(await statuses(50, hook))).toEqual(new Set([401])); // signature rejected, never 429
  });

  it("CORS preflights are not counted", async () => {
    const u = await signUp(plain, "alice");
    const app = limited({ global: { max: 2, windowMs: 60_000 } }, { corsOrigins: ["app://loop"] });
    const preflight = () =>
      app.inject({ method: "OPTIONS", url: "/me", headers: { origin: "app://loop", "access-control-request-method": "GET" } });
    expect(new Set(await statuses(6, preflight))).toEqual(new Set([204]));
    expect(await statuses(3, () => caller(app)("GET", "/me", u.token))).toEqual([200, 200, 429]);
  });
});

describe("configuration", () => {
  it("TRUST_PROXY off ignores X-Forwarded-For, so a client cannot reset its limit by changing it", async () => {
    const app = limited({ "login-ip": { max: 2, windowMs: 60_000 } }, { trustProxy: false });
    expect(await statuses(4, (i) => login(app, "a@example.com", as(`203.0.113.${i}`)))).toEqual([401, 401, 429, 429]);
  });

  it("TRUST_PROXY as a hop count takes the address that many proxies from the right", async () => {
    const app = limited({ "login-ip": { max: 1, windowMs: 60_000 } }, { trustProxy: 1 });
    // one trusted proxy appended the real client; whatever the client put before it is ignored
    expect(await statuses(2, (i) => login(app, "a@example.com", as(`10.0.0.${i}, 203.0.113.7`)))).toEqual([401, 429]);
  });

  it("RATE_LIMIT=off disables everything", async () => {
    const app = limited({ "login-ip": { max: 1, windowMs: 60_000 }, global: { max: 1, windowMs: 60_000 } }, { rateLimit: false });
    expect(new Set(await statuses(10, () => login(app)))).toEqual(new Set([401]));
  });

  it("fails open when the store errors", async () => {
    const down = { defineCommand() {}, on() {}, quit: async () => {}, rateLimit: (...a: unknown[]) => (a.at(-1) as (e: Error) => void)(new Error("down")) } as unknown as Redis;
    const app = limited({ "login-ip": { max: 1, windowMs: 60_000 } }, { rateLimitOverrides: { redis: down, policies: { "login-ip": { max: 1, windowMs: 60_000 } } } });
    expect(await statuses(3, () => login(app))).toEqual([401, 401, 401]);
  });

  it("shares budgets between app instances on the same Redis namespace, and not across namespaces", async () => {
    const namespace = `${randomUUID()}:`;
    const policies = { "login-ip": { max: 2, windowMs: 60_000 } };
    const [one, two] = [limited(policies, { rateLimitOverrides: { policies, namespace } }), limited(policies, { rateLimitOverrides: { policies, namespace } })];
    expect([(await login(one)).statusCode, (await login(two)).statusCode, (await login(one)).statusCode]).toEqual([401, 401, 429]);
    expect((await login(limited(policies))).statusCode).toBe(401);
  });
});

describe("route decisions", () => {
  it("a route that is neither in ROUTES nor EXEMPT stops the app from starting", async () => {
    const app = buildApp(env);
    expect(() => app.get("/undecided", async () => "x")).toThrow(/GET \/undecided has no rate-limit decision/);
    await app.close();
  });

  it("every ROUTES / EXEMPT row is a real route (no stale rows)", async () => {
    await plain.ready();
    for (const row of [...Object.keys(ROUTES), ...Object.keys(EXEMPT)]) {
      const [method, url] = row.split(" ");
      expect(plain.hasRoute({ method: method as "GET", url }), row).toBe(true);
    }
    for (const policy of Object.values(ROUTES).flat()) expect(POLICIES, policy).toHaveProperty(policy);
  });
});

describe("Socket.IO", () => {
  const sockets: Socket[] = [];
  afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));
  const connectAs = (port: number, token: string, ip?: string) =>
    new Promise<Socket | Error>((resolve) => {
      const s = io(`http://127.0.0.1:${port}`, { auth: { token }, reconnection: false, forceNew: true, extraHeaders: ip ? as(ip) : {} });
      sockets.push(s);
      s.once("connect", () => resolve(s));
      s.once("connect_error", resolve);
    });

  it("limits connection attempts per IP, counting rejected tokens too", async () => {
    const u = await signUp(plain, "alice");
    const app = limited({ "socket-connect": { max: 2, windowMs: 60_000 } });
    const port = await listen(app);
    expect(await connectAs(port, "bad-token")).toHaveProperty("message", "Unauthorized");
    expect(await connectAs(port, u.token)).toHaveProperty("connected", true);
    expect(await connectAs(port, u.token)).toHaveProperty("message", "Too many requests");
    expect(await connectAs(port, u.token, "203.0.113.9"), "another IP").toHaveProperty("connected", true);
  });

  it("ignores X-Forwarded-For on sockets while TRUST_PROXY is off", async () => {
    const u = await signUp(plain, "alice");
    const app = limited({ "socket-connect": { max: 1, windowMs: 60_000 } }, { trustProxy: false });
    const port = await listen(app);
    expect(await connectAs(port, u.token, "203.0.113.1")).toHaveProperty("connected", true);
    expect(await connectAs(port, u.token, "203.0.113.2")).toHaveProperty("message", "Too many requests");
  });

  it("caps channel:subscribe per socket", async () => {
    const u = await signUp(plain, "alice");
    const { general } = await guildWith(plain, u);
    const app = limited({ "socket-subscribe": { max: 3, windowMs: 60_000 } });
    const s = (await connectAs(await listen(app), u.token)) as Socket;
    const acks = [];
    for (let i = 0; i < 4; i++) acks.push(await s.emitWithAck("channel:subscribe", { channelId: general.id }));
    expect(acks).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: false, error: "Too many requests" }]);
    await settle();
  });

  it("caps live presence:away pushes per socket, but still keeps the flag", async () => {
    const [a, b] = await Promise.all([signUp(plain, "alice"), signUp(plain, "bob")]);
    await befriend(plain, a, b);
    const app = limited({ "socket-presence": { max: 2, windowMs: 60_000 } });
    const port = await listen(app);
    const watcher = await connectTo(port, a.token, ["presence:update"], sockets);
    const s = await connectTo(port, b.token, [], sockets);
    await until(() => watcher.got["presence:update"]!.length === 1); // online
    for (const away of [true, false, true]) s.emit("presence:away", { away }); // the third is over budget
    await until(() => watcher.got["presence:update"]!.length === 3);
    await settle();
    expect(watcher.got["presence:update"]!.map((u) => u.status)).toEqual(["online", "idle", "online"]);
    await vi.waitFor(async () => expect((await caller(app)("GET", "/friends", a.token)).json().friends[0].status).toBe("idle"), { timeout: 3000 });
  });
});
