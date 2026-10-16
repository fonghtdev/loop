import { Permission as P } from "@loop/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, makeRole, resetDb, signUp, uploadImage } from "../../test/helpers.js";
import { sweepAuditLog } from "./audit.js";

/** The audit log: one entry per moderation / admin change (voice entries are in voice/moderation.test.ts), reading, retention. */
const app = buildApp(env);
const call = caller(app);
const SECRET = "the secret text of a message";

/** owner acts; victim is a plain member with a message in #general and a thread they started; reader holds VIEW_AUDIT_LOG. */
async function setup() {
  const [owner, victim, reader, outsider] = await Promise.all(["owner", "victim", "reader", "outsider"].map((n) => signUp(app, n)));
  const { guild, general } = await guildWith(app, owner, victim, reader);
  const base = `/guilds/${guild.id}`;
  const role = await makeRole(guild.id, 1, P.SEND_MESSAGES);
  const readerRole = await makeRole(guild.id, 2, P.VIEW_AUDIT_LOG, [reader.id]);
  const message = (await call("POST", `/channels/${general.id}/messages`, victim.token, { content: SECRET })).json() as { id: string };
  const thread = (await call("POST", `/channels/${general.id}/messages/${message.id}/thread`, victim.token, { name: "talk" })).json() as { id: string };
  await prisma.auditLog.deleteMany(); // start from an empty log
  return { owner, victim, reader, outsider, guild, general, base, role, readerRole, message, thread };
}
type S = Awaited<ReturnType<typeof setup>>;
type Entry = { id: string; action: string; actor: { id: string } | null; targetUser: { id: string } | null; targetId: string | null; meta: Record<string, unknown>; createdAt: string };
const log = async (s: S, query = "", token = s.owner.token) => (await call("GET", `${s.base}/audit-log${query}`, token)).json() as { entries: Entry[]; hasMore: boolean };

beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

type Row = {
  action: string;
  /** Runs the change as the owner; returns the HTTP status. `before` prepares what the change needs (not logged). */
  run: (s: S) => Promise<number>;
  before?: (s: S) => Promise<unknown>;
  status: number;
  targetUserId?: (s: S) => string;
  targetId?: (s: S) => string | null;
  meta?: (s: S) => Record<string, unknown>;
};
const as = (s: S) => (method: Parameters<typeof call>[0], url: string, body?: object) => call(method, url, s.owner.token, body).then((r) => r.statusCode);
const createdId = async (s: S, url: string, body: object) => ((await call("POST", url, s.owner.token, body)).json() as { id: string }).id;

const ROWS: Row[] = [
  { action: "member.kick", status: 204, run: (s) => as(s)("DELETE", `${s.base}/members/${s.victim.id}`), targetUserId: (s) => s.victim.id },
  {
    action: "member.ban", status: 204, run: (s) => as(s)("PUT", `${s.base}/bans/${s.victim.id}`, { reason: "spam", deleteMessageHours: 1 }),
    targetUserId: (s) => s.victim.id, meta: () => ({ reason: "spam", deleteMessageHours: 1, deletedMessages: 1 }),
  },
  {
    action: "member.unban", status: 204, before: (s) => prisma.guildBan.create({ data: { guildId: s.guild.id, userId: s.outsider.id } }),
    run: (s) => as(s)("DELETE", `${s.base}/bans/${s.outsider.id}`), targetUserId: (s) => s.outsider.id,
  },
  { action: "role.create", status: 201, run: (s) => as(s)("POST", `${s.base}/roles`, { name: "mods", permissions: P.KICK_MEMBERS }), meta: () => ({ name: "mods", permissions: P.KICK_MEMBERS }) },
  {
    action: "role.update", status: 200, run: (s) => as(s)("PATCH", `${s.base}/roles/${s.role.id}`, { name: "renamed", color: "#112233" }),
    targetId: (s) => s.role.id, meta: () => ({ name: "renamed", changed: ["name", "color"] }),
  },
  { action: "role.delete", status: 204, run: (s) => as(s)("DELETE", `${s.base}/roles/${s.role.id}`), targetId: (s) => s.role.id, meta: (s) => ({ name: s.role.name }) },
  {
    action: "role.assign", status: 204, run: (s) => as(s)("PUT", `${s.base}/members/${s.victim.id}/roles/${s.role.id}`),
    targetUserId: (s) => s.victim.id, targetId: (s) => s.role.id, meta: (s) => ({ name: s.role.name }),
  },
  {
    action: "role.unassign", status: 204, before: (s) => prisma.memberRole.create({ data: { guildId: s.guild.id, userId: s.victim.id, roleId: s.role.id } }),
    run: (s) => as(s)("DELETE", `${s.base}/members/${s.victim.id}/roles/${s.role.id}`), targetUserId: (s) => s.victim.id, targetId: (s) => s.role.id,
  },
  { action: "role.reorder", status: 200, run: (s) => as(s)("PUT", `${s.base}/roles/order`, { roleIds: [s.role.id, s.readerRole.id] }) },
  { action: "channel.create", status: 201, run: (s) => as(s)("POST", `${s.base}/channels`, { name: "news", type: "VOICE" }), meta: () => ({ name: "news", type: "VOICE" }) },
  {
    action: "channel.update", status: 200, run: (s) => as(s)("PATCH", `/channels/${s.general.id}`, { topic: "hello" }),
    targetId: (s) => s.general.id, meta: () => ({ name: "general", changed: ["topic"] }),
  },
  {
    action: "channel.delete", status: 204, before: (s) => call("POST", `${s.base}/channels`, s.owner.token, { name: "spare", type: "TEXT" }),
    run: (s) => as(s)("DELETE", `${s.base}/channels/${s.general.id}`), targetId: (s) => s.general.id, meta: () => ({ name: "general" }),
  },
  { action: "channel.category_create", status: 201, run: (s) => as(s)("POST", `${s.base}/categories`, { name: "Extra" }), meta: () => ({ name: "Extra" }) },
  {
    action: "channel.category_update", status: 200,
    run: async (s) => as(s)("PATCH", `${s.base}/categories/${(await prisma.category.findFirstOrThrow({ where: { guildId: s.guild.id } })).id}`, { name: "Renamed" }),
    meta: () => ({ name: "Renamed" }),
  },
  {
    action: "channel.category_delete", status: 204,
    run: async (s) => as(s)("DELETE", `${s.base}/categories/${(await prisma.category.findFirstOrThrow({ where: { guildId: s.guild.id }, orderBy: { position: "asc" } })).id}`),
    meta: () => ({ name: "Kênh văn bản" }),
  },
  {
    action: "channel.layout_update", status: 200,
    run: async (s) => {
      const categories = await prisma.category.findMany({ where: { guildId: s.guild.id }, orderBy: { position: "desc" } });
      return as(s)("PUT", `${s.base}/layout`, { categories: categories.map((c) => c.id), channels: [{ id: s.general.id, categoryId: categories[0]!.id }] });
    },
  },
  {
    action: "channel.overwrite_set", status: 200, run: (s) => as(s)("PUT", `/channels/${s.general.id}/overwrites/${s.role.id}`, { allow: P.SEND_MESSAGES, deny: 0 }),
    targetId: (s) => s.general.id, meta: (s) => ({ channel: "general", role: s.role.name, allow: P.SEND_MESSAGES, deny: 0 }),
  },
  {
    action: "channel.overwrite_delete", status: 204,
    before: (s) => prisma.channelOverwrite.create({ data: { guildId: s.guild.id, channelId: s.general.id, roleId: s.role.id, allow: P.SEND_MESSAGES, deny: 0 } }),
    run: (s) => as(s)("DELETE", `/channels/${s.general.id}/overwrites/${s.role.id}`), targetId: (s) => s.general.id, meta: (s) => ({ channel: "general", role: s.role.name }),
  },
  {
    action: "channel.overwrite_set", status: 200, run: (s) => as(s)("PUT", `/channels/${s.general.id}/overwrites/members/${s.victim.id}`, { allow: 0, deny: P.SEND_MESSAGES }),
    targetUserId: (s) => s.victim.id, targetId: (s) => s.general.id, meta: () => ({ channel: "general", role: null, allow: 0, deny: P.SEND_MESSAGES }),
  },
  { action: "invite.create", status: 201, run: (s) => as(s)("POST", `${s.base}/invites`, { maxUses: 3 }), meta: () => ({ maxUses: 3, expiresInSeconds: null }) },
  {
    action: "invite.revoke", status: 204, before: (s) => prisma.invite.create({ data: { code: "byvictim", guildId: s.guild.id, createdById: s.victim.id } }),
    run: (s) => as(s)("DELETE", `${s.base}/invites/byvictim`), targetUserId: (s) => s.victim.id,
  },
  { action: "guild.update", status: 200, run: (s) => as(s)("PATCH", s.base, { name: "New name" }), meta: () => ({ name: "New name" }) },
  { action: "guild.icon", status: 200, run: async (s) => (await uploadImage(app, s.owner.token, `${s.base}/icon`)).complete.statusCode, meta: () => ({ removed: false }) },
  {
    action: "guild.icon", status: 204, before: (s) => prisma.guild.update({ where: { id: s.guild.id }, data: { iconHash: "aaaaaaaaaaaa" } }),
    run: (s) => as(s)("DELETE", `${s.base}/icon`), meta: () => ({ removed: true }),
  },
  { action: "guild.transfer", status: 200, run: (s) => as(s)("POST", `${s.base}/transfer`, { userId: s.victim.id }), targetUserId: (s) => s.victim.id },
  { action: "message.delete", status: 204, run: (s) => as(s)("DELETE", `/messages/${s.message.id}`), targetUserId: (s) => s.victim.id, targetId: (s) => s.general.id, meta: () => ({}) },
  { action: "message.thread_delete", status: 204, run: (s) => as(s)("DELETE", `/threads/${s.thread.id}`), targetUserId: (s) => s.victim.id, targetId: (s) => s.thread.id, meta: () => ({ name: "talk" }) },
  { action: "automod.rule_create", status: 201, run: (s) => as(s)("POST", `${s.base}/automod/rules`, { name: "words", keywords: ["bad"] }), meta: () => ({ name: "words" }) },
  {
    action: "automod.rule_update", status: 200,
    run: async (s) => as(s)("PATCH", `${s.base}/automod/rules/${await createdId(s, `${s.base}/automod/rules`, { name: "w", keywords: ["x"] })}`, { enabled: false, keywords: ["y"] }),
    meta: () => ({ name: "w", changed: ["enabled", "keywords"] }),
  },
  {
    action: "automod.rule_delete", status: 204,
    run: async (s) => as(s)("DELETE", `${s.base}/automod/rules/${await createdId(s, `${s.base}/automod/rules`, { name: "w", keywords: ["x"] })}`),
    meta: () => ({ name: "w" }),
  },
];

describe("every moderation / admin change writes one entry", () => {
  it.each(ROWS.map((row) => [row.action, row] as const))("%s", async (_, row) => {
    const s = await setup();
    await row.before?.(s);
    expect(await row.run(s)).toBe(row.status);
    const { entries } = await log(s, `?action=${row.action}`, s.reader.token); // the owner may have handed the guild over
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry!.actor?.id).toBe(s.owner.id);
    expect(entry!.targetUser?.id ?? null).toBe(row.targetUserId?.(s) ?? null);
    if (row.targetId) expect(entry!.targetId).toBe(row.targetId(s));
    if (row.meta) expect(entry!.meta).toEqual(row.meta(s));
    // never what a message said (the victim's message, its thread and their mentions are in the fixture)
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(SECRET);
  });

  it("a layout change is one entry however many rows move, and no-op changes write nothing", async () => {
    const s = await setup();
    await call("POST", `${s.base}/channels`, s.owner.token, { name: "b", type: "TEXT" });
    const categories = await prisma.category.findMany({ where: { guildId: s.guild.id } });
    const channels = await prisma.channel.findMany({ where: { guildId: s.guild.id, parentChannelId: null } });
    await call("PUT", `${s.base}/layout`, s.owner.token, { categories: categories.map((c) => c.id).reverse(), channels: channels.map((c) => ({ id: c.id, categoryId: null })) });
    expect((await log(s, "?action=channel.layout_update")).entries).toHaveLength(1);
    await prisma.auditLog.deleteMany();
    // already assigned / not assigned / nothing to remove / not banned: nothing changed, nothing logged
    await call("DELETE", `${s.base}/members/${s.victim.id}/roles/${s.role.id}`, s.owner.token);
    await call("DELETE", `/channels/${s.general.id}/overwrites/${s.role.id}`, s.owner.token);
    await call("DELETE", `${s.base}/bans/${s.outsider.id}`, s.owner.token);
    // the author deleting their own message or thread is not moderation
    await call("DELETE", `/threads/${s.thread.id}`, s.victim.token);
    await call("DELETE", `/messages/${s.message.id}`, s.victim.token);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe("reading the log", () => {
  it("needs VIEW_AUDIT_LOG (owner and ADMINISTRATOR pass), 404 outside the guild", async () => {
    const s = await setup();
    expect((await call("GET", `${s.base}/audit-log`, s.outsider.token)).statusCode).toBe(404);
    expect((await call("GET", `${s.base}/audit-log`, s.victim.token)).statusCode).toBe(403);
    expect((await call("GET", `${s.base}/audit-log`, s.reader.token)).statusCode).toBe(200);
    await makeRole(s.guild.id, 3, P.ADMINISTRATOR, [s.victim.id]);
    expect((await call("GET", `${s.base}/audit-log`, s.victim.token)).statusCode).toBe(200);
  });

  it("pages newest first by `before`, filters by action, group and actor, and says when there is more", async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) await call("POST", `${s.base}/categories`, s.owner.token, { name: `c${i}` });
    await call("PATCH", s.base, s.reader.token, { name: "x" }); // 403: nothing logged
    await makeRole(s.guild.id, 3, P.ADMINISTRATOR, [s.reader.id]);
    await call("PATCH", s.base, s.reader.token, { name: "by reader" });
    const first = await log(s, "?limit=2");
    expect(first.entries.map((e) => e.action)).toEqual(["guild.update", "channel.category_create"]);
    expect(first.entries[1]!.meta).toEqual({ name: "c4" });
    expect(first.hasMore).toBe(true);
    const seen = [...first.entries];
    for (let page = first; page.hasMore; ) {
      page = await log(s, `?limit=2&before=${page.entries.at(-1)!.id}`);
      seen.push(...page.entries);
    }
    expect(seen.map((e) => e.meta.name)).toEqual(["by reader", "c4", "c3", "c2", "c1", "c0"]);
    expect(new Set(seen.map((e) => e.id)).size).toBe(6);
    expect((await log(s, "?action=channel")).entries).toHaveLength(5); // a whole group
    expect((await log(s, "?action=guild.update")).entries).toHaveLength(1);
    expect((await log(s, `?actorId=${s.reader.id}`)).entries.map((e) => e.action)).toEqual(["guild.update"]);
    expect((await log(s, "?limit=50")).hasMore).toBe(false);
  });

  it("refuses bad queries and cursors of another guild", async () => {
    const s = await setup();
    const other = await guildWith(app, s.outsider);
    await call("PATCH", `/guilds/${other.guild.id}`, s.outsider.token, { name: "theirs" });
    const foreign = (await prisma.auditLog.findFirstOrThrow({ where: { guildId: other.guild.id } })).id;
    for (const q of ["?limit=0", "?limit=51", "?before=nope", "?action=DROP%20TABLE", "?extra=1", `?before=${foreign}`]) {
      expect((await call("GET", `${s.base}/audit-log${q}`, s.owner.token)).statusCode, q).toBe(400);
    }
    expect((await log(s)).entries).toEqual([]); // the other guild's entry never shows here
  });

  it("an entry outlives its actor's and target's accounts (null user)", async () => {
    const s = await setup();
    await call("DELETE", `${s.base}/members/${s.victim.id}`, s.owner.token);
    await prisma.$executeRaw`DELETE FROM "Session" WHERE "userId" = ${s.victim.id}::uuid`;
    await prisma.message.deleteMany({ where: { authorId: s.victim.id } });
    await prisma.user.delete({ where: { id: s.victim.id } });
    const [entry] = (await log(s)).entries;
    expect(entry).toMatchObject({ action: "member.kick", targetUser: null });
  });
});

describe("retention and failures", () => {
  it("the sweep deletes entries older than 90 days only", async () => {
    const s = await setup();
    const day = 24 * 60 * 60 * 1000;
    await prisma.auditLog.createMany({
      data: [91, 89].map((days) => ({ guildId: s.guild.id, action: "guild.update", metadata: { name: `${days}` }, createdAt: new Date(Date.now() - days * day) })),
    });
    expect(await sweepAuditLog()).toBe(1);
    expect((await prisma.auditLog.findMany()).map((e) => (e.metadata as { name: string }).name)).toEqual(["89"]);
  });

  it("a failing log write does not fail a change made outside a transaction, but rolls back one made inside", async () => {
    const failing = buildApp({ ...env, auditWriter: async () => Promise.reject(new Error("disk full")) });
    const fcall = caller(failing);
    try {
      const s = await setup();
      expect((await fcall("PATCH", `${s.base}/roles/${s.role.id}`, s.owner.token, { name: "still renamed" })).statusCode).toBe(200);
      expect((await prisma.role.findUniqueOrThrow({ where: { id: s.role.id } })).name).toBe("still renamed");
      expect((await fcall("DELETE", `/messages/${s.message.id}`, s.owner.token)).statusCode).toBe(204);
      // a kick is one transaction with its entry: no entry, no kick
      expect((await fcall("DELETE", `${s.base}/members/${s.victim.id}`, s.owner.token)).statusCode).toBe(500);
      expect(await prisma.member.count({ where: { guildId: s.guild.id, userId: s.victim.id } })).toBe(1);
      expect(await prisma.auditLog.count()).toBe(0);
    } finally {
      await failing.close();
    }
  });
});
