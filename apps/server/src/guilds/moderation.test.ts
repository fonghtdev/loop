import { DEFAULT_EVERYONE_PERMISSIONS, Permission as P } from "@loop/shared";
import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, makeRole, resetDb, setEveryone, signUp } from "../../test/helpers.js";
import { connect, listen, settle, until } from "../../test/sockets.js";
import { keepsHigherRoles } from "./roles.js";

/** Bans, invite management, role reordering and per-member channel overwrites: the permission rules of each. */
const app = buildApp(env);
const call = caller(app);
const sockets: Socket[] = [];
let port: number;
const status = async (...args: Parameters<typeof call>) => (await call(...args)).statusCode;
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  port = await listen(app);
});
beforeEach(resetDb);
afterEach(() => {
  sockets.splice(0).forEach((s) => s.disconnect());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/**
 * owner; mod (top 5, `modPerms`); peer (5); low (2); plain (no role); admin (3, ADMINISTRATOR only); stranger
 * (an account outside the guild). Roles are distinct per holder; `above` (7) is held by nobody.
 */
async function setup(modPerms = P.BAN_MEMBERS | P.MANAGE_ROLES | P.KICK_MEMBERS) {
  const names = ["owner", "mod", "peer", "low", "plain", "admin", "stranger"];
  const [owner, mod, peer, low, plain, admin, stranger] = await Promise.all(names.map((n) => signUp(app, n)));
  const { guild, general } = await guildWith(app, owner!, mod!, peer!, low!, plain!, admin!);
  const g = guild.id;
  const roles = {
    mod: await makeRole(g, 5, modPerms, [mod!.id]),
    peer: await makeRole(g, 6, 0, [peer!.id]),
    above: await makeRole(g, 7),
    low: await makeRole(g, 2, 0, [low!.id]),
    admin: await makeRole(g, 3, P.ADMINISTRATOR, [admin!.id]),
  };
  // peer sits at 6 so the mod is strictly below them; equal ranks are covered in roles.test.ts
  return { owner: owner!, mod: mod!, peer: peer!, low: low!, plain: plain!, admin: admin!, stranger: stranger!, guild, general, roles, base: `/guilds/${g}` };
}
type S = Awaited<ReturnType<typeof setup>>;
const isMember = async (s: S, userId: string) => !!(await prisma.member.findUnique({ where: { guildId_userId: { guildId: s.guild.id, userId } } }));
const banUrl = (s: S, userId: string) => `${s.base}/bans/${userId}`;
const newInvite = async (s: S, token = s.owner.token, body = {}) => (await call("POST", `${s.base}/invites`, token, body)).json() as { code: string };

describe("bans", () => {
  it("follows the kick hierarchy: below you only, never the owner, never yourself", async () => {
    const s = await setup();
    expect(await status("PUT", banUrl(s, s.peer.id), s.mod.token, {})).toBe(403); // above the mod
    expect(await status("PUT", banUrl(s, s.owner.id), s.mod.token, {})).toBe(403);
    expect(await status("PUT", banUrl(s, s.mod.id), s.mod.token, {})).toBe(400);
    expect(await prisma.guildBan.count()).toBe(0);
    expect(await status("PUT", banUrl(s, s.low.id), s.mod.token, { reason: "spam" })).toBe(204);
    expect(await isMember(s, s.low.id)).toBe(false);
    expect(await status("GET", s.base, s.low.token)).toBe(404);
    expect(await status("PUT", banUrl(s, s.mod.id), s.owner.token, {})).toBe(204); // the owner outranks everyone
  });

  it("ADMINISTRATOR passes the bit but not the hierarchy", async () => {
    const s = await setup();
    expect(await status("PUT", banUrl(s, s.low.id), s.admin.token, {})).toBe(204); // 3 > 2, no BAN_MEMBERS bit
    expect(await status("PUT", banUrl(s, s.mod.id), s.admin.token, {})).toBe(403); // 3 < 5
    expect(await status("GET", `${s.base}/bans`, s.admin.token)).toBe(200);
  });

  it("without BAN_MEMBERS: 403; outsiders 404; @everyone does not have it", async () => {
    const s = await setup(P.KICK_MEMBERS | P.MANAGE_ROLES);
    expect(await status("PUT", banUrl(s, s.low.id), s.mod.token, {})).toBe(403);
    expect(await status("PUT", banUrl(s, s.low.id), s.plain.token, {})).toBe(403);
    expect(await status("PUT", banUrl(s, s.low.id), s.stranger.token, {})).toBe(404);
    expect(await status("GET", `${s.base}/bans`, s.plain.token)).toBe(403);
    expect(await status("DELETE", banUrl(s, s.low.id), s.plain.token)).toBe(403);
  });

  it("bans a non-member by id; unknown and malformed ids are 404; a caller with no role cannot ban anyone", async () => {
    const s = await setup();
    expect(await status("PUT", banUrl(s, UNKNOWN), s.mod.token, {})).toBe(404);
    expect(await status("PUT", banUrl(s, "nope"), s.mod.token, {})).toBe(404);
    await setEveryone(s.guild.id, DEFAULT_EVERYONE_PERMISSIONS | P.BAN_MEMBERS);
    expect(await status("PUT", banUrl(s, s.stranger.id), s.plain.token, {})).toBe(403); // top 0 is not above a non-member's 0
    expect(await status("PUT", banUrl(s, s.stranger.id), s.mod.token, {})).toBe(204);
    const { bans } = (await call("GET", `${s.base}/bans`, s.mod.token)).json();
    expect(bans).toEqual([
      { user: { id: s.stranger.id, username: "stranger", displayName: null, avatarHash: null }, reason: null, bannedBy: { id: s.mod.id, username: "mod" }, createdAt: expect.any(String) },
    ]);
  });

  it("validates the body", async () => {
    const s = await setup();
    for (const body of [{ deleteMessageHours: 2 }, { reason: "x".repeat(201) }, { reason: "a‮b" }, { extra: 1 }]) {
      expect(await status("PUT", banUrl(s, s.low.id), s.mod.token, body), JSON.stringify(body)).toBe(400);
    }
    expect(await status("PUT", banUrl(s, s.low.id), s.mod.token, { reason: "   " })).toBe(204); // blank = no reason
    expect((await prisma.guildBan.findFirstOrThrow()).reason).toBeNull();
  });

  it("a banned user cannot come back through any invite, and learns nothing but the ban", async () => {
    const s = await setup();
    const old = await newInvite(s);
    expect(await status("PUT", banUrl(s, s.low.id), s.mod.token, { reason: "secret reason" })).toBe(204);
    const fresh = await newInvite(s, s.owner.token, { maxUses: 5 });
    for (const { code } of [old, fresh]) {
      const res = await call("POST", `/invites/${code}/join`, s.low.token);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "You are banned from this server" });
    }
    expect(await isMember(s, s.low.id)).toBe(false);
    expect((await prisma.invite.findUniqueOrThrow({ where: { code: fresh.code } })).uses).toBe(0); // nothing burnt
    expect(await status("POST", "/invites/unknown/join", s.low.token)).toBe(404);
    // a banned non-member too
    expect(await status("PUT", banUrl(s, s.stranger.id), s.mod.token, {})).toBe(204);
    expect(await status("POST", `/invites/${fresh.code}/join`, s.stranger.token)).toBe(403);
  });

  it("unban (idempotent) lets them join again, without their old roles", async () => {
    const s = await setup();
    const { code } = await newInvite(s);
    await call("PUT", banUrl(s, s.low.id), s.mod.token, {});
    expect(await prisma.memberRole.count({ where: { userId: s.low.id } })).toBe(0);
    expect(await status("DELETE", banUrl(s, s.low.id), s.mod.token)).toBe(204);
    expect(await status("DELETE", banUrl(s, s.low.id), s.mod.token)).toBe(204);
    expect(await status("DELETE", banUrl(s, "nope"), s.mod.token)).toBe(404);
    expect(await status("POST", `/invites/${code}/join`, s.low.token)).toBe(200);
    expect(await isMember(s, s.low.id)).toBe(true);
    expect(await prisma.memberRole.count({ where: { userId: s.low.id } })).toBe(0);
  });

  it("deletes the last N hours of their messages in this guild only, and announces each deletion", async () => {
    const s = await setup();
    const other = (await call("POST", "/guilds", s.low.token, { name: "elsewhere" })).json();
    const post = (channelId: string, hoursAgo = 0) =>
      prisma.message.create({ data: { channelId, authorId: s.low.id, content: "m", createdAt: new Date(Date.now() - hoursAgo * 3_600_000) } });
    const starter = await post(s.general.id, 3);
    const thread = await prisma.channel.create({
      data: { guildId: s.guild.id, parentChannelId: s.general.id, type: "THREAD", name: "th", position: 0, starterMessageId: starter.id, createdById: s.owner.id, lastMessageAt: new Date() },
    });
    const [recent, inThread, old, elsewhere] = [await post(s.general.id), await post(thread.id), await post(s.general.id, 2), await post(other.channels[0].id)];
    const byOwner = await prisma.message.create({ data: { channelId: s.general.id, authorId: s.owner.id, content: "keep" } });
    await prisma.reaction.create({ data: { messageId: recent.id, userId: s.owner.id, emoji: "👍" } });
    const watcher = await connect(port, s.owner.token, ["message:delete", "thread:updated"], sockets);
    await watcher.emitWithAck("channel:subscribe", { channelId: s.general.id });
    await watcher.emitWithAck("channel:subscribe", { channelId: thread.id });

    expect(await status("PUT", banUrl(s, s.low.id), s.mod.token, { deleteMessageHours: 1 })).toBe(204);
    const left = (await prisma.message.findMany({ select: { id: true } })).map((m) => m.id).sort();
    expect(left).toEqual([starter.id, old.id, elsewhere.id, byOwner.id].sort());
    expect(await prisma.reaction.count()).toBe(0);
    await until(() => watcher.got["message:delete"]!.length === 2);
    expect(watcher.got["message:delete"]!.map((e) => e.id).sort()).toEqual([recent.id, inThread.id].sort());
    await until(() => watcher.got["thread:updated"]!.some((t) => t.id === thread.id && t.messageCount === 0));
  });

  it("deleteMessageHours 0 (default) keeps everything", async () => {
    const s = await setup();
    await prisma.message.create({ data: { channelId: s.general.id, authorId: s.low.id, content: "m" } });
    await call("PUT", banUrl(s, s.low.id), s.mod.token, {});
    expect(await prisma.message.count()).toBe(1);
  });

  it("their sockets leave the guild's rooms and their member overwrites go", async () => {
    const s = await setup();
    await prisma.channelMemberOverwrite.create({ data: { guildId: s.guild.id, channelId: s.general.id, userId: s.low.id, allow: 0, deny: P.SEND_MESSAGES } });
    const sock = await connect(port, s.low.token, ["message:new"], sockets);
    const control = await connect(port, s.owner.token, ["message:new"], sockets);
    for (const c of [sock, control]) expect(await c.emitWithAck("channel:subscribe", { channelId: s.general.id })).toEqual({ ok: true });
    expect(await status("PUT", banUrl(s, s.low.id), s.mod.token, {})).toBe(204);
    expect(await prisma.channelMemberOverwrite.count()).toBe(0);
    await call("POST", `/channels/${s.general.id}/messages`, s.owner.token, { content: "after" });
    await until(() => control.got["message:new"]!.length === 1);
    await settle();
    expect(sock.got["message:new"]).toEqual([]);
    expect(await sock.emitWithAck("channel:subscribe", { channelId: s.general.id })).toMatchObject({ ok: false });
  });
});

describe("invites management", () => {
  /** creator holds only @everyone's CREATE_INVITE; manager has MANAGE_ROLES (role 4). */
  async function invites() {
    const s = await setup();
    const manager = await signUp(app, "manager");
    await call("POST", `/invites/${(await newInvite(s)).code}/join`, manager.token);
    await makeRole(s.guild.id, 4, P.MANAGE_ROLES, [manager.id]);
    const own = await newInvite(s, s.plain.token, { maxUses: 2, expiresInSeconds: 3600 });
    const owners = await newInvite(s);
    return { ...s, manager, own, owners };
  }
  const list = async (s: S, token: string) => (await call("GET", `${s.base}/invites`, token)).json().invites as { code: string }[];

  it("a creator lists and revokes only their own; a manager and the owner see and revoke all", async () => {
    const s = await invites();
    const mine = await list(s, s.plain.token);
    expect(mine).toEqual([
      { code: s.own.code, createdBy: { id: s.plain.id, username: "plain" }, createdAt: expect.any(String), expiresAt: expect.any(String), maxUses: 2, uses: 0 },
    ]);
    expect((await list(s, s.manager.token)).map((i) => i.code).sort()).toEqual((await list(s, s.owner.token)).map((i) => i.code).sort());
    expect((await list(s, s.owner.token)).length).toBe(4); // plus the two the owner made to fill the guild
    expect(await status("DELETE", `${s.base}/invites/${s.owners.code}`, s.plain.token)).toBe(403);
    expect(await status("DELETE", `${s.base}/invites/${s.own.code}`, s.plain.token)).toBe(204);
    expect(await status("DELETE", `${s.base}/invites/${s.owners.code}`, s.manager.token)).toBe(204);
    expect(await status("DELETE", `${s.base}/invites/${s.owners.code}`, s.manager.token)).toBe(404);
  });

  it("a revoked invite cannot be joined", async () => {
    const s = await invites();
    await call("DELETE", `${s.base}/invites/${s.own.code}`, s.owner.token);
    expect(await status("POST", `/invites/${s.own.code}/join`, s.stranger.token)).toBe(404);
  });

  it("without CREATE_INVITE nor MANAGE_ROLES: 403; outsiders and another guild's codes: 404", async () => {
    const s = await invites();
    await setEveryone(s.guild.id, DEFAULT_EVERYONE_PERMISSIONS & ~P.CREATE_INVITE);
    expect(await status("GET", `${s.base}/invites`, s.plain.token)).toBe(403);
    expect(await status("DELETE", `${s.base}/invites/${s.own.code}`, s.plain.token)).toBe(403); // even their own
    expect(await status("GET", `${s.base}/invites`, s.stranger.token)).toBe(404);
    const elsewhere = (await call("POST", "/guilds", s.stranger.token, { name: "B" })).json().guild;
    const foreign = (await call("POST", `/guilds/${elsewhere.id}/invites`, s.stranger.token, {})).json();
    expect(await status("DELETE", `${s.base}/invites/${foreign.code}`, s.owner.token)).toBe(404);
    expect(await prisma.invite.count({ where: { code: foreign.code } })).toBe(1);
  });

  it("max uses and expiry are enforced at join and the count shows in the list", async () => {
    const s = await invites();
    const one = await newInvite(s, s.owner.token, { maxUses: 1 });
    expect(await status("POST", `/invites/${one.code}/join`, s.stranger.token)).toBe(200);
    const late = await signUp(app, "late");
    expect(await status("POST", `/invites/${one.code}/join`, late.token)).toBe(404);
    expect((await list(s, s.owner.token)).find((i) => i.code === one.code)).toMatchObject({ uses: 1, maxUses: 1 });
    await prisma.invite.update({ where: { code: s.owners.code }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await status("POST", `/invites/${s.owners.code}/join`, late.token)).toBe(404);
  });
});

describe("role reorder", () => {
  /** owner; mod holds M (10, MANAGE_ROLES); a holds A (3, KICK); b holds B (2, KICK); `top` (20) is above the mod. */
  async function ranks() {
    const [owner, mod, a, b] = await Promise.all(["owner", "mod", "alpha", "bravo"].map((n) => signUp(app, n)));
    const { guild } = await guildWith(app, owner!, mod!, a!, b!);
    const g = guild.id;
    const r = {
      top: await makeRole(g, 20),
      M: await makeRole(g, 10, P.MANAGE_ROLES, [mod!.id]),
      A: await makeRole(g, 3, P.KICK_MEMBERS, [a!.id]),
      B: await makeRole(g, 2, P.KICK_MEMBERS, [b!.id]),
    };
    return { owner: owner!, mod: mod!, a: a!, b: b!, guild, r, url: `/guilds/${g}/roles/order` };
  }
  const positions = async (guildId: string) =>
    Object.fromEntries((await prisma.role.findMany({ where: { guildId } })).map((r) => [r.id, r.position]));

  it("the owner renumbers everything n..1; @everyone stays 0; assignments are untouched; members hear roles:updated", async () => {
    const s = await ranks();
    const sock = await connect(port, s.a.token, ["roles:updated"], sockets);
    const res = await call("PUT", s.url, s.owner.token, { roleIds: [s.r.B.id, s.r.top.id, s.r.A.id, s.r.M.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((r: { id: string }) => r.id)).toEqual([s.guild.id, s.r.M.id, s.r.A.id, s.r.top.id, s.r.B.id]);
    expect(await positions(s.guild.id)).toEqual({ [s.guild.id]: 0, [s.r.M.id]: 1, [s.r.A.id]: 2, [s.r.top.id]: 3, [s.r.B.id]: 4 });
    expect(await prisma.memberRole.count({ where: { guildId: s.guild.id } })).toBe(3);
    await until(() => sock.got["roles:updated"]!.length === 1);
    expect(sock.got["roles:updated"]![0]).toEqual({ guildId: s.guild.id });
  });

  it("the list must be exactly the current set: 409 stale, 400 duplicates or @everyone", async () => {
    const s = await ranks();
    const all = [s.r.top.id, s.r.M.id, s.r.A.id, s.r.B.id];
    expect(await status("PUT", s.url, s.owner.token, { roleIds: all.slice(0, 3) })).toBe(409);
    expect(await status("PUT", s.url, s.owner.token, { roleIds: [...all, UNKNOWN] })).toBe(409);
    expect(await status("PUT", s.url, s.owner.token, { roleIds: [...all.slice(0, 3), UNKNOWN] })).toBe(409);
    expect(await status("PUT", s.url, s.owner.token, { roleIds: [...all, s.r.B.id] })).toBe(400);
    expect(await status("PUT", s.url, s.owner.token, { roleIds: [...all, s.guild.id] })).toBe(400);
    expect(await status("PUT", s.url, s.owner.token, { roleIds: ["nope"] })).toBe(400);
    const elsewhere = (await call("POST", "/guilds", s.mod.token, { name: "B" })).json().guild;
    const foreign = await makeRole(elsewhere.id, 1);
    expect(await status("PUT", s.url, s.owner.token, { roleIds: [...all.slice(0, 3), foreign.id] })).toBe(409);
    expect(await positions(s.guild.id)).toEqual({ [s.guild.id]: 0, [s.r.top.id]: 20, [s.r.M.id]: 10, [s.r.A.id]: 3, [s.r.B.id]: 2 });
  });

  it("a non-owner reorders only below their top, and never moves a role to or above it", async () => {
    const s = await ranks();
    const { top, M, A, B } = s.r;
    expect(await status("PUT", s.url, s.mod.token, { roleIds: [top.id, A.id, M.id, B.id] })).toBe(403); // A above the mod
    expect(await status("PUT", s.url, s.mod.token, { roleIds: [M.id, top.id, A.id, B.id] })).toBe(403); // swaps the roles above
    expect(await status("PUT", s.url, s.mod.token, { roleIds: [top.id, M.id, B.id, A.id] })).toBe(200);
    expect(await positions(s.guild.id)).toMatchObject({ [top.id]: 4, [M.id]: 3, [B.id]: 2, [A.id]: 1 });
    // an ADMINISTRATOR is held to the same bound
    await prisma.role.update({ where: { id: M.id }, data: { permissions: P.ADMINISTRATOR } });
    expect(await status("PUT", s.url, s.mod.token, { roleIds: [M.id, top.id, A.id, B.id] })).toBe(403);
  });

  it("only the owner may break a tie among the roles at or above the caller", async () => {
    expect(keepsHigherRoles([{ id: "m", position: 5 }, { id: "p", position: 5 }, { id: "l", position: 1 }], ["m", "p", "l"], 5)).toBe(false);
    expect(keepsHigherRoles([{ id: "m", position: 5 }, { id: "p", position: 6 }, { id: "l", position: 1 }], ["p", "m", "l"], 5)).toBe(true);
    expect(keepsHigherRoles([{ id: "m", position: 5 }, { id: "l", position: 1 }, { id: "k", position: 1 }], ["m", "k", "l"], 5)).toBe(true); // ties below are the caller's to order
  });

  it("the new order decides who outranks whom", async () => {
    const s = await ranks();
    const kick = (by: { token: string }, target: { id: string }) => status("DELETE", `/guilds/${s.guild.id}/members/${target.id}`, by.token);
    expect(await kick(s.b, s.a)).toBe(403); // B (2) is below A (3)
    expect(await status("PUT", s.url, s.mod.token, { roleIds: [s.r.top.id, s.r.M.id, s.r.B.id, s.r.A.id] })).toBe(200);
    expect(await kick(s.a, s.b)).toBe(403);
    expect(await kick(s.b, s.a)).toBe(204);
  });
});

describe("member overwrites", () => {
  const url = (s: S, userId: string, channelId = s.general.id) => `/channels/${channelId}/overwrites/members/${userId}`;
  const send = (s: S, who: { token: string }, channelId = s.general.id) => status("POST", `/channels/${channelId}/messages`, who.token, { content: "hi" });

  it("a member allow beats a role deny, a member deny beats a role allow", async () => {
    const s = await setup();
    await call("PUT", `/channels/${s.general.id}/overwrites/${s.roles.low.id}`, s.owner.token, { allow: 0, deny: P.SEND_MESSAGES });
    expect(await send(s, s.low)).toBe(403);
    expect((await call("PUT", url(s, s.low.id), s.mod.token, { allow: P.SEND_MESSAGES, deny: 0 })).json()).toEqual({ channelId: s.general.id, userId: s.low.id, allow: P.SEND_MESSAGES, deny: 0 });
    expect(await send(s, s.low)).toBe(201);
    await call("PUT", `/channels/${s.general.id}/overwrites/${s.roles.low.id}`, s.owner.token, { allow: P.SEND_MESSAGES, deny: 0 });
    await call("PUT", url(s, s.low.id), s.mod.token, { allow: 0, deny: P.SEND_MESSAGES });
    expect(await send(s, s.low)).toBe(403);
    expect(await status("DELETE", url(s, s.low.id), s.mod.token)).toBe(204);
    expect(await send(s, s.low)).toBe(201);
  });

  it("a VIEW deny hides the channel (and its threads) at once and takes the sockets out", async () => {
    const s = await setup();
    const starter = await prisma.message.create({ data: { channelId: s.general.id, authorId: s.owner.id, content: "s" } });
    const thread = await prisma.channel.create({
      data: { guildId: s.guild.id, parentChannelId: s.general.id, type: "THREAD", name: "th", position: 0, starterMessageId: starter.id, createdById: s.owner.id, lastMessageAt: new Date() },
    });
    const sock = await connect(port, s.low.token, ["message:new"], sockets);
    const control = await connect(port, s.owner.token, ["message:new"], sockets);
    for (const c of [sock, control]) expect(await c.emitWithAck("channel:subscribe", { channelId: thread.id })).toEqual({ ok: true });
    expect(await status("PUT", url(s, s.low.id), s.mod.token, { allow: 0, deny: P.VIEW_CHANNEL })).toBe(200);
    await call("POST", `/channels/${thread.id}/messages`, s.owner.token, { content: "private" });
    await until(() => control.got["message:new"]!.length === 1);
    await settle();
    expect(sock.got["message:new"]).toEqual([]);
    expect(await status("GET", `/channels/${thread.id}/messages`, s.low.token)).toBe(404);
    expect(await status("GET", `/channels/${s.general.id}/messages`, s.low.token)).toBe(404);
    const channels = (await call("GET", s.base, s.low.token)).json().channels as { id: string }[];
    expect(channels.map((c) => c.id)).not.toContain(s.general.id);
    // everyone else still sees it, with the member overwrite listed for the client's computePermissions
    const seen = (await call("GET", s.base, s.plain.token)).json().channels.find((c: { id: string }) => c.id === s.general.id);
    expect(seen.memberOverwrites).toEqual([{ userId: s.low.id, allow: 0, deny: P.VIEW_CHANNEL }]);
  });

  it("rule 1: only members strictly below the caller; not the owner, not yourself, not a non-member", async () => {
    const s = await setup();
    const body = { allow: 0, deny: P.SEND_MESSAGES };
    expect(await status("PUT", url(s, s.peer.id), s.mod.token, body)).toBe(403); // cannot restrict someone above
    expect(await status("PUT", url(s, s.owner.id), s.mod.token, body)).toBe(403);
    expect(await status("PUT", url(s, s.mod.id), s.mod.token, body)).toBe(400);
    expect(await status("PUT", url(s, s.stranger.id), s.mod.token, body)).toBe(404);
    expect(await status("PUT", url(s, UNKNOWN), s.mod.token, body)).toBe(404);
    expect(await status("PUT", url(s, s.mod.id), s.admin.token, body)).toBe(403); // ADMINISTRATOR is not above the hierarchy
    expect(await status("PUT", url(s, s.peer.id), s.owner.token, body)).toBe(200);
    expect(await prisma.channelMemberOverwrite.count()).toBe(1);
  });

  it("rule 2: every bit touched, old and new, must be held in that channel", async () => {
    const s = await setup(P.MANAGE_ROLES);
    expect(await status("PUT", url(s, s.low.id), s.mod.token, { allow: P.MANAGE_MESSAGES, deny: 0 })).toBe(403);
    expect(await status("PUT", url(s, s.low.id), s.mod.token, { allow: 0, deny: P.MOVE_MEMBERS })).toBe(403);
    await call("PUT", url(s, s.low.id), s.owner.token, { allow: 0, deny: P.MANAGE_MESSAGES });
    expect(await status("DELETE", url(s, s.low.id), s.mod.token)).toBe(403); // lifting a deny grants it
    expect(await status("PUT", url(s, s.low.id), s.mod.token, { allow: 0, deny: P.SEND_MESSAGES })).toBe(403); // the old deny is touched too
    expect(await prisma.channelMemberOverwrite.findFirstOrThrow()).toMatchObject({ deny: P.MANAGE_MESSAGES });
  });

  it("only channel bits, never both ways; threads and foreign channels are not targets", async () => {
    const s = await setup();
    for (const body of [{ allow: P.BAN_MEMBERS, deny: 0 }, { allow: P.SEND_MESSAGES, deny: P.SEND_MESSAGES }, {}]) {
      expect(await status("PUT", url(s, s.low.id), s.mod.token, body), JSON.stringify(body)).toBe(400);
    }
    const starter = await prisma.message.create({ data: { channelId: s.general.id, authorId: s.owner.id, content: "s" } });
    const thread = await prisma.channel.create({
      data: { guildId: s.guild.id, parentChannelId: s.general.id, type: "THREAD", name: "th", position: 0, starterMessageId: starter.id, createdById: s.owner.id, lastMessageAt: new Date() },
    });
    expect(await status("PUT", url(s, s.low.id, thread.id), s.mod.token, { allow: 0, deny: P.SEND_MESSAGES })).toBe(404);
    const elsewhere = (await call("POST", "/guilds", s.low.token, { name: "B" })).json();
    expect(await status("PUT", url(s, s.low.id, elsewhere.channels[0].id), s.mod.token, { allow: 0, deny: P.SEND_MESSAGES })).toBe(404);
    expect(await status("PUT", url(s, s.mod.id, elsewhere.channels[0].id), s.low.token, { allow: 0, deny: P.SEND_MESSAGES })).toBe(404); // the mod is not in B
  });

  it("leaving or being kicked deletes the member's overwrites; they come back without them", async () => {
    const s = await setup();
    const { code } = await newInvite(s);
    await call("PUT", url(s, s.low.id), s.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    await call("PUT", url(s, s.plain.id), s.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    expect(await status("DELETE", `${s.base}/members/${s.low.id}`, s.mod.token)).toBe(204);
    expect(await status("DELETE", `${s.base}/members/me`, s.plain.token)).toBe(204);
    expect(await prisma.channelMemberOverwrite.count()).toBe(0);
    await call("POST", `/invites/${code}/join`, s.low.token);
    expect(await status("GET", `/channels/${s.general.id}/messages`, s.low.token)).toBe(200);
  });
});
