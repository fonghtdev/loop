import { ALL_PERMISSIONS, Permission as P } from "@loop/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, isAttachmentRoute, isSocialRoute, isVoiceRoute, makeRole, type Method, resetDb, setEveryone, signUp } from "../../test/helpers.js";

/**
 * Every authenticated route and what it needs. A route missing from both MATRIX and PUBLIC fails the
 * guard below, so a new route cannot ship without a permission decision.
 */
const app = buildApp(env);
const call = caller(app);
const ALL_BUT_ADMIN = ALL_PERMISSIONS & ~P.ADMINISTRATOR;

/** Routes outside any guild, with the reason they need no guild permission. */
const PUBLIC: Record<string, string> = {
  "POST /guilds": "creates a new guild; the caller becomes its owner",
  "GET /guilds": "lists only the caller's own guilds",
  "POST /invites/:code/join": "the invite code is the capability",
  "OPTIONS *": "CORS preflight from @fastify/cors: headers only, no data (cors.test.ts)",
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Need = number | "member" | "owner";
type Row = { route: string; need: Need; ok: number; url: (f: Fixture) => string; body?: object };

const MATRIX: Row[] = [
  { route: "GET /guilds/:guildId", need: "member", ok: 200, url: (f) => f.base },
  { route: "DELETE /guilds/:guildId", need: "owner", ok: 204, url: (f) => f.base },
  { route: "POST /guilds/:guildId/transfer", need: "owner", ok: 200, url: (f) => `${f.base}/transfer`, body: {} },
  { route: "GET /guilds/:guildId/members", need: "member", ok: 200, url: (f) => `${f.base}/members` },
  { route: "DELETE /guilds/:guildId/members/me", need: "member", ok: 204, url: (f) => `${f.base}/members/me` },
  { route: "GET /guilds/:guildId/roles", need: "member", ok: 200, url: (f) => `${f.base}/roles` },
  { route: "POST /guilds/:guildId/channels", need: P.MANAGE_CHANNELS, ok: 201, url: (f) => `${f.base}/channels`, body: { name: "new", type: "TEXT" } },
  { route: "DELETE /guilds/:guildId/channels/:channelId", need: P.MANAGE_CHANNELS, ok: 204, url: (f) => `${f.base}/channels/${f.extra.id}` },
  { route: "DELETE /guilds/:guildId/channels/:channelId", need: P.VIEW_CHANNEL, ok: 204, url: (f) => `${f.base}/channels/${f.extra.id}` },
  { route: "POST /guilds/:guildId/categories", need: P.MANAGE_CHANNELS, ok: 201, url: (f) => `${f.base}/categories`, body: { name: "cat" } },
  { route: "PATCH /guilds/:guildId/categories/:categoryId", need: P.MANAGE_CHANNELS, ok: 200, url: (f) => `${f.base}/categories/${f.category.id}`, body: { name: "renamed" } },
  { route: "DELETE /guilds/:guildId/categories/:categoryId", need: P.MANAGE_CHANNELS, ok: 204, url: (f) => `${f.base}/categories/${f.category.id}` },
  { route: "PUT /guilds/:guildId/layout", need: P.MANAGE_CHANNELS, ok: 200, url: (f) => `${f.base}/layout`, body: {} },
  { route: "POST /guilds/:guildId/invites", need: P.CREATE_INVITE, ok: 201, url: (f) => `${f.base}/invites`, body: {} },
  { route: "DELETE /guilds/:guildId/members/:userId", need: P.KICK_MEMBERS, ok: 204, url: (f) => `${f.base}/members/${f.victim.id}` },
  { route: "POST /guilds/:guildId/roles", need: P.MANAGE_ROLES, ok: 201, url: (f) => `${f.base}/roles`, body: { name: "new" } },
  { route: "PATCH /guilds/:guildId/roles/:roleId", need: P.MANAGE_ROLES, ok: 200, url: (f) => `${f.base}/roles/${f.low.id}`, body: { name: "renamed" } },
  { route: "DELETE /guilds/:guildId/roles/:roleId", need: P.MANAGE_ROLES, ok: 204, url: (f) => `${f.base}/roles/${f.low.id}` },
  { route: "PUT /guilds/:guildId/members/:userId/roles/:roleId", need: P.MANAGE_ROLES, ok: 204, url: (f) => `${f.base}/members/${f.victim.id}/roles/${f.low.id}` },
  { route: "DELETE /guilds/:guildId/members/:userId/roles/:roleId", need: P.MANAGE_ROLES, ok: 204, url: (f) => `${f.base}/members/${f.victim.id}/roles/${f.low.id}` },
  { route: "PUT /channels/:channelId/overwrites/:roleId", need: P.MANAGE_ROLES, ok: 200, url: (f) => `/channels/${f.general.id}/overwrites/${f.low.id}`, body: { allow: P.SEND_MESSAGES, deny: 0 } },
  { route: "PUT /channels/:channelId/overwrites/:roleId", need: P.VIEW_CHANNEL, ok: 200, url: (f) => `/channels/${f.general.id}/overwrites/${f.low.id}`, body: { allow: P.SEND_MESSAGES, deny: 0 } },
  { route: "DELETE /channels/:channelId/overwrites/:roleId", need: P.MANAGE_ROLES, ok: 204, url: (f) => `/channels/${f.general.id}/overwrites/${f.low.id}` },
  { route: "DELETE /channels/:channelId/overwrites/:roleId", need: P.VIEW_CHANNEL, ok: 204, url: (f) => `/channels/${f.general.id}/overwrites/${f.low.id}` },
  { route: "POST /channels/:channelId/messages", need: P.SEND_MESSAGES, ok: 201, url: (f) => f.messages, body: { content: "hi" } },
  { route: "POST /channels/:channelId/messages", need: P.VIEW_CHANNEL, ok: 201, url: (f) => f.messages, body: { content: "hi" } },
  { route: "GET /channels/:channelId/messages", need: P.VIEW_CHANNEL, ok: 200, url: (f) => f.messages },
  { route: "PATCH /messages/:messageId", need: P.VIEW_CHANNEL, ok: 200, url: (f) => `/messages/${f.ownMsg.id}`, body: { content: "edited" } },
  { route: "DELETE /messages/:messageId", need: P.VIEW_CHANNEL, ok: 204, url: (f) => `/messages/${f.ownMsg.id}` },
  { route: "DELETE /messages/:messageId", need: P.MANAGE_MESSAGES, ok: 204, url: (f) => `/messages/${f.victimMsg.id}` },
];

/**
 * Owner, `actor` (the caller under test, holding role `actorRole` at position 10) and `victim` (target of
 * kicks/assignments). @everyone has no permissions, so the actor has exactly what actorRole gives.
 */
async function fixture() {
  const [owner, actor, victim, outsider] = await Promise.all(["owner", "actor", "victim", "outsider"].map((n) => signUp(app, n)));
  const { guild, general } = await guildWith(app, owner, actor, victim);
  const base = `/guilds/${guild.id}`;
  const extra = (await call("POST", `${base}/channels`, owner.token, { name: "extra", type: "TEXT" })).json();
  await setEveryone(guild.id, 0);
  const actorRole = await makeRole(guild.id, 10, 0, [actor.id]);
  const low = await makeRole(guild.id, 1);
  const categories = await prisma.category.findMany({ where: { guildId: guild.id }, orderBy: { position: "asc" } });
  const category = categories[0]!;
  const layout = {
    categories: categories.map((c) => c.id),
    channels: [general, extra].map((c) => ({ id: c.id, categoryId: category.id })),
  };
  const msg = (authorId: string) => prisma.message.create({ data: { channelId: general.id, authorId, content: "m" } });
  return {
    owner, actor, victim, outsider, guild, general, extra, base, actorRole, low, category, layout,
    messages: `/channels/${general.id}/messages`,
    ownMsg: await msg(actor.id),
    victimMsg: await msg(victim.id),
  };
}

const setActor = (f: Fixture, permissions: number) => prisma.role.update({ where: { id: f.actorRole.id }, data: { permissions } });
const name = (n: Need) => (typeof n === "number" ? Object.entries(P).find(([, bit]) => bit === n)![0] : n);
const send = (row: Row, f: Fixture, token: string) => {
  const [method] = row.route.split(" ") as [Method];
  const body = row.route.endsWith("/transfer") ? { userId: f.victim.id } : row.route.endsWith("/layout") ? f.layout : row.body;
  return call(method, row.url(f), token, body);
};

beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("route permission matrix", () => {
  it.each(MATRIX.map((row) => [`${row.route} needs ${name(row.need)}`, row] as const))("%s", async (_, row) => {
    const f = await fixture();
    if (row.need === "member") {
      expect((await send(row, f, f.outsider.token)).statusCode, "outsider").toBe(404);
      expect((await send(row, f, f.actor.token)).statusCode, "member with no permissions").toBe(row.ok);
    } else if (row.need === "owner") {
      await setActor(f, ALL_PERMISSIONS);
      expect((await send(row, f, f.actor.token)).statusCode, "administrator").toBe(403);
      expect((await send(row, f, f.owner.token)).statusCode, "owner").toBe(row.ok);
    } else {
      await setActor(f, ALL_BUT_ADMIN & ~row.need);
      const denied = row.need === P.VIEW_CHANNEL ? 404 : 403;
      expect((await send(row, f, f.actor.token)).statusCode, "without the permission").toBe(denied);
      await setActor(f, ALL_BUT_ADMIN);
      expect((await send(row, f, f.actor.token)).statusCode, "with it").toBe(row.ok);
    }
  });

  it("every authenticated route is in the matrix or explicitly public", async () => {
    const probe = buildApp(env);
    const registered: string[] = [];
    // A root onRoute hook added before ready() sees every route of the authenticated plugin.
    probe.addHook("onRoute", (r) => {
      for (const m of [r.method].flat()) if (m !== "HEAD") registered.push(`${m} ${r.url}`);
    });
    await probe.ready();
    await probe.close();
    const decided = new Set([...MATRIX.map((r) => r.route), ...Object.keys(PUBLIC)]);
    expect(registered.filter((r) => !isSocialRoute(r) && !isAttachmentRoute(r) && !isVoiceRoute(r) && !decided.has(r)), "routes without a permission decision").toEqual([]);
    expect([...decided].filter((r) => !registered.includes(r)), "stale matrix rows").toEqual([]);
  });
});
