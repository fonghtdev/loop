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
  "POST /bots": "creates a bot owned by the caller; people only (bots.test.ts)",
  "GET /bots": "lists only the caller's own bots",
  "POST /bots/:botId/token": "owner of the bot only, others get 404 (bots.test.ts)",
  "DELETE /bots/:botId": "owner of the bot only, others get 404 (bots.test.ts)",
  "PATCH /me/profile": "edits the caller's own profile (profiles/profiles.test.ts)",
  "GET /users/:userId/profile": "visibility is friendship or a shared guild, else 404 (profiles/profiles.test.ts)",
  "POST /me/avatar/upload": "the caller's own avatar (profiles/profiles.test.ts)",
  "POST /me/avatar/complete": "only the uploader's own pending upload, others get 404 (profiles/profiles.test.ts)",
  "DELETE /me/avatar": "the caller's own avatar",
  "POST /me/banner/upload": "the caller's own banner (profiles/profiles.test.ts)",
  "POST /me/banner/complete": "only the uploader's own pending upload, others get 404 (profiles/profiles.test.ts)",
  "DELETE /me/banner": "the caller's own banner",
  "GET /users/:userId/avatar": "unauthenticated by design (<img> sends no token): a 302 to the image or one uniform 404",
  "GET /users/:userId/banner": "unauthenticated by design, as the avatar",
  "GET /guilds/:guildId/icon": "unauthenticated by design, as the avatar",
  "GET /embeds/:embedId/thumbnail": "unauthenticated by design (<img>): the random embed id comes only from message JSON; 302 or one uniform 404 (embeds/embeds.test.ts)",
  "GET /gifs/config": "authenticated, no target: whether the GIF provider is configured (gifs/gifs.test.ts)",
  "GET /gifs/search": "authenticated, no target: a search of the GIF provider, 404 when off (gifs/gifs.test.ts)",
  "GET /gifs/trending": "authenticated, no target: the provider's trending list, 404 when off (gifs/gifs.test.ts)",
  "GET /me/unread": "lists only conversations the caller can VIEW / is part of (messages/read-state.test.ts)",
  "OPTIONS *":"CORS preflight from @fastify/cors: headers only, no data (cors.test.ts)",
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** A bit, or a list of bits any one of which is enough (the first one alone is checked). */
type Need = number | number[] | "member" | "owner" | "admin";
/** `okOwner`: the owner's status when it differs (a delete: the administrator's call already removed the thing). */
type Row = { route: string; need: Need; ok: number; okOwner?: number; url: (f: Fixture) => string; body?: object | ((f: Fixture) => object) };

const MATRIX: Row[] = [
  { route: "GET /guilds/:guildId", need: "member", ok: 200, url: (f) => f.base },
  { route: "PATCH /guilds/:guildId", need: "admin", ok: 200, url: (f) => f.base, body: { name: "renamed" } },
  { route: "POST /guilds/:guildId/icon/upload", need: "admin", ok: 201, url: (f) => `${f.base}/icon/upload`, body: { contentType: "image/png", size: 10 } },
  // past the permission check the upload id is unknown: 404 (the real flow is in profiles/profiles.test.ts)
  { route: "POST /guilds/:guildId/icon/complete", need: "admin", ok: 404, url: (f) => `${f.base}/icon/complete`, body: { id: "00000000-0000-4000-8000-000000000000" } },
  { route: "DELETE /guilds/:guildId/icon", need: "admin", ok: 204, url: (f) => `${f.base}/icon` },
  { route: "PATCH /channels/:channelId", need: P.MANAGE_CHANNELS, ok: 200, url: (f) => `/channels/${f.extra.id}`, body: { topic: "t" } },
  { route: "PATCH /channels/:channelId", need: P.VIEW_CHANNEL, ok: 200, url: (f) => `/channels/${f.extra.id}`, body: { topic: "t" } },
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
  { route: "PUT /messages/:messageId/reactions/:emoji", need: P.SEND_MESSAGES, ok: 204, url: (f) => `/messages/${f.ownMsg.id}/reactions/${encodeURIComponent("👍")}` },
  { route: "PUT /messages/:messageId/reactions/:emoji", need: P.VIEW_CHANNEL, ok: 204, url: (f) => `/messages/${f.ownMsg.id}/reactions/${encodeURIComponent("👍")}` },
  { route: "DELETE /messages/:messageId/reactions/:emoji", need: P.VIEW_CHANNEL, ok: 204, url: (f) => `/messages/${f.ownMsg.id}/reactions/${encodeURIComponent("👍")}` },
  { route: "PUT /messages/:messageId/pin", need: P.MANAGE_MESSAGES, ok: 204, url: (f) => `/messages/${f.victimMsg.id}/pin` },
  { route: "PUT /messages/:messageId/pin", need: P.VIEW_CHANNEL, ok: 204, url: (f) => `/messages/${f.victimMsg.id}/pin` },
  { route: "DELETE /messages/:messageId/pin", need: P.MANAGE_MESSAGES, ok: 204, url: (f) => `/messages/${f.victimMsg.id}/pin` },
  { route: "DELETE /messages/:messageId/pin", need: P.VIEW_CHANNEL, ok: 204, url: (f) => `/messages/${f.victimMsg.id}/pin` },
  { route: "PUT /channels/:channelId/read", need: P.VIEW_CHANNEL, ok: 204, url: (f) => `/channels/${f.general.id}/read`, body: { seq: "1" } },
  { route: "GET /guilds/:guildId/messages/search", need: "member", ok: 200, url: (f) => `${f.base}/messages/search?q=hi` },
  { route: "GET /channels/:channelId/pins", need: P.VIEW_CHANNEL, ok: 200, url: (f) => `/channels/${f.general.id}/pins` },
  // threads: the parent's bits (the fixture thread hangs off #general and was started by the owner)
  { route: "POST /channels/:channelId/messages/:messageId/thread", need: P.SEND_MESSAGES, ok: 201, url: (f) => `${f.messages}/${f.ownMsg.id}/thread`, body: { name: "t" } },
  { route: "POST /channels/:channelId/messages/:messageId/thread", need: P.VIEW_CHANNEL, ok: 201, url: (f) => `${f.messages}/${f.ownMsg.id}/thread`, body: { name: "t" } },
  { route: "GET /channels/:channelId/threads", need: P.VIEW_CHANNEL, ok: 200, url: (f) => `/channels/${f.general.id}/threads` },
  { route: "PATCH /threads/:threadId", need: P.MANAGE_MESSAGES, ok: 200, url: (f) => `/threads/${f.thread.id}`, body: { archived: true } },
  { route: "PATCH /threads/:threadId", need: P.VIEW_CHANNEL, ok: 200, url: (f) => `/threads/${f.thread.id}`, body: { archived: true } },
  { route: "DELETE /threads/:threadId", need: P.MANAGE_MESSAGES, ok: 204, url: (f) => `/threads/${f.thread.id}` },
  { route: "DELETE /threads/:threadId", need: P.VIEW_CHANNEL, ok: 204, url: (f) => `/threads/${f.thread.id}` },
  // moderation (guilds/moderation.test.ts has the hierarchy and the rest)
  { route: "GET /guilds/:guildId/bans", need: P.BAN_MEMBERS, ok: 200, url: (f) => `${f.base}/bans` },
  { route: "PUT /guilds/:guildId/bans/:userId", need: P.BAN_MEMBERS, ok: 204, url: (f) => `${f.base}/bans/${f.victim.id}`, body: {} },
  { route: "DELETE /guilds/:guildId/bans/:userId", need: P.BAN_MEMBERS, ok: 204, url: (f) => `${f.base}/bans/${f.outsider.id}` },
  // the actor's own invites with CREATE_INVITE, everyone's with MANAGE_ROLES
  { route: "GET /guilds/:guildId/invites", need: [P.CREATE_INVITE, P.MANAGE_ROLES], ok: 200, url: (f) => `${f.base}/invites` },
  { route: "GET /guilds/:guildId/invites", need: [P.MANAGE_ROLES, P.CREATE_INVITE], ok: 200, url: (f) => `${f.base}/invites` },
  { route: "DELETE /guilds/:guildId/invites/:code", need: [P.CREATE_INVITE, P.MANAGE_ROLES], ok: 204, url: (f) => `${f.base}/invites/${f.actorInvite.code}` },
  { route: "PUT /guilds/:guildId/roles/order", need: P.MANAGE_ROLES, ok: 200, url: (f) => `${f.base}/roles/order`, body: (f) => ({ roleIds: [f.actorRole.id, f.low.id] }) },
  { route: "PUT /channels/:channelId/overwrites/members/:userId", need: P.MANAGE_ROLES, ok: 200, url: (f) => `/channels/${f.general.id}/overwrites/members/${f.victim.id}`, body: { allow: P.SEND_MESSAGES, deny: 0 } },
  { route: "PUT /channels/:channelId/overwrites/members/:userId", need: P.VIEW_CHANNEL, ok: 200, url: (f) => `/channels/${f.general.id}/overwrites/members/${f.victim.id}`, body: { allow: P.SEND_MESSAGES, deny: 0 } },
  { route: "DELETE /channels/:channelId/overwrites/members/:userId", need: P.MANAGE_ROLES, ok: 204, url: (f) => `/channels/${f.general.id}/overwrites/members/${f.victim.id}` },
  { route: "DELETE /channels/:channelId/overwrites/members/:userId", need: P.VIEW_CHANNEL, ok: 204, url: (f) => `/channels/${f.general.id}/overwrites/members/${f.victim.id}` },
  // administration B (guilds/audit.test.ts, guilds/automod.test.ts have the rest)
  { route: "GET /guilds/:guildId/audit-log", need: P.VIEW_AUDIT_LOG, ok: 200, url: (f) => `${f.base}/audit-log` },
  { route: "GET /guilds/:guildId/automod/rules", need: "admin", ok: 200, url: (f) => `${f.base}/automod/rules` },
  { route: "POST /guilds/:guildId/automod/rules", need: "admin", ok: 201, url: (f) => `${f.base}/automod/rules`, body: { name: "r", keywords: ["x"] } },
  { route: "PATCH /guilds/:guildId/automod/rules/:ruleId", need: "admin", ok: 200, url: (f) => `${f.base}/automod/rules/${f.rule.id}`, body: { enabled: false } },
  { route: "DELETE /guilds/:guildId/automod/rules/:ruleId", need: "admin", ok: 204, okOwner: 404, url: (f) => `${f.base}/automod/rules/${f.rule.id}` },
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
  const [ownMsg, victimMsg] = [await msg(actor.id), await msg(victim.id)];
  const thread = await prisma.channel.create({
    data: { guildId: guild.id, parentChannelId: general.id, type: "THREAD", name: "th", position: 0, starterMessageId: victimMsg.id, createdById: owner.id, lastMessageAt: new Date() },
  });
  const actorInvite = await prisma.invite.create({ data: { code: "actorinv", guildId: guild.id, createdById: actor.id } });
  const rule = await prisma.autoModRule.create({ data: { guildId: guild.id, name: "rule", keywords: ["nope"] } });
  return {
    owner, actor, victim, outsider, guild, general, extra, base, actorRole, low, category, layout,
    messages: `/channels/${general.id}/messages`,
    ownMsg, victimMsg, thread, actorInvite, rule,
  };
}

const setActor = (f: Fixture, permissions: number) => prisma.role.update({ where: { id: f.actorRole.id }, data: { permissions } });
const bitName = (n: number) => Object.entries(P).find(([, bit]) => bit === n)![0];
const name = (n: Need) => (typeof n === "number" ? bitName(n) : Array.isArray(n) ? n.map(bitName).join(" or ") : n);
const send = (row: Row, f: Fixture, token: string) => {
  const [method] = row.route.split(" ") as [Method];
  const body = row.route.endsWith("/transfer") ? { userId: f.victim.id } : row.route.endsWith("/layout") ? f.layout : typeof row.body === "function" ? row.body(f) : row.body;
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
    } else if (row.need === "admin") {
      expect((await send(row, f, f.outsider.token)).statusCode, "outsider").toBe(404);
      await setActor(f, ALL_BUT_ADMIN);
      expect((await send(row, f, f.actor.token)).statusCode, "every permission but ADMINISTRATOR").toBe(403);
      await setActor(f, P.ADMINISTRATOR);
      expect((await send(row, f, f.actor.token)).statusCode, "administrator").toBe(row.ok);
      expect((await send(row, f, f.owner.token)).statusCode, "owner").toBe(row.okOwner ?? row.ok);
    } else if (row.need === "owner") {
      await setActor(f, ALL_PERMISSIONS);
      expect((await send(row, f, f.actor.token)).statusCode, "administrator").toBe(403);
      expect((await send(row, f, f.owner.token)).statusCode, "owner").toBe(row.ok);
    } else if (Array.isArray(row.need)) {
      const any = row.need.reduce((all, bit) => all | bit, 0);
      await setActor(f, ALL_BUT_ADMIN & ~any);
      expect((await send(row, f, f.actor.token)).statusCode, "without any of them").toBe(403);
      await setActor(f, row.need[0]!);
      expect((await send(row, f, f.actor.token)).statusCode, "with the first alone").toBe(row.ok);
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
