import { AUTOMOD_BLOCKED, foldText, Permission as P } from "@loop/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import type { Fetcher } from "../embeds/fetch.js";
import { befriend, caller, env, guildWith, makeRole, resetDb, signUp, uploadAttachment } from "../../test/helpers.js";

/** AutoMod keyword rules: who manages them, what they block (before anything is stored) and who is exempt. */
const pageCalls: string[] = [];
const fetcher = { page: async (url: string) => (pageCalls.push(url), null), image: async () => null } as unknown as Fetcher;
const app = buildApp({ ...env, linkPreviews: true, embedOverrides: { fetcher } }); // a send that got through would fetch its link
const call = caller(app);

/** owner; member (plain); mod (MANAGE_MESSAGES via a role); admin (ADMINISTRATOR); bot user stands in as a plain member. */
async function setup() {
  const [owner, member, mod, admin, friend] = await Promise.all(["owner", "member", "mod", "admin", "friend"].map((n) => signUp(app, n)));
  const { guild, general } = await guildWith(app, owner, member, mod, admin);
  await makeRole(guild.id, 2, P.MANAGE_MESSAGES, [mod.id]);
  await makeRole(guild.id, 3, P.ADMINISTRATOR, [admin.id]);
  const base = `/guilds/${guild.id}`;
  const rule = (await call("POST", `${base}/automod/rules`, owner.token, { name: "Words", keywords: ["đồ ngốc", "spam link"] })).json() as { id: string };
  return { owner, member, mod, admin, friend, guild, general, base, rule };
}
type S = Awaited<ReturnType<typeof setup>>;
const send = (s: S, token: string, content: string, channelId = s.general.id) => call("POST", `/channels/${channelId}/messages`, token, { content });

beforeEach(async () => {
  await resetDb();
  pageCalls.length = 0;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("managing rules (owner / ADMINISTRATOR only)", () => {
  it("creates, lists, edits and deletes; other members get 403, other guilds' rules 404", async () => {
    const s = await setup();
    expect((await call("GET", `${s.base}/automod/rules`, s.mod.token)).statusCode).toBe(403); // MANAGE_MESSAGES is not enough
    const listed = (await call("GET", `${s.base}/automod/rules`, s.admin.token)).json();
    expect(listed.rules).toEqual([expect.objectContaining({ id: s.rule.id, name: "Words", enabled: true, keywords: ["đồ ngốc", "spam link"], createdById: s.owner.id })]);
    const patched = await call("PATCH", `${s.base}/automod/rules/${s.rule.id}`, s.admin.token, { name: "Renamed", keywords: ["x"] });
    expect(patched.json()).toMatchObject({ name: "Renamed", keywords: ["x"], enabled: true });
    const other = await guildWith(app, s.friend);
    expect((await call("PATCH", `/guilds/${other.guild.id}/automod/rules/${s.rule.id}`, s.friend.token, { enabled: false })).statusCode).toBe(404);
    expect((await call("DELETE", `/guilds/${other.guild.id}/automod/rules/${s.rule.id}`, s.friend.token)).statusCode).toBe(404);
    expect((await call("DELETE", `${s.base}/automod/rules/not-a-uuid`, s.owner.token)).statusCode).toBe(404);
    expect((await call("DELETE", `${s.base}/automod/rules/${s.rule.id}`, s.owner.token)).statusCode).toBe(204);
    expect(await prisma.autoModRule.count()).toBe(0);
  });

  it("at most 5 rules per guild, also when created in parallel", async () => {
    const s = await setup();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call("POST", `${s.base}/automod/rules`, s.owner.token, { name: `r${i}`, keywords: ["k"] })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(4); // + the setup's rule = 5
    expect(results.filter((r) => r.statusCode === 409).map((r) => r.json().error)).toEqual(Array(4).fill("AutoMod rule limit reached (5)"));
    expect(await prisma.autoModRule.count({ where: { guildId: s.guild.id } })).toBe(5);
  });

  it("validates names and keywords (400)", async () => {
    const s = await setup();
    const bad = [
      {}, { name: "r" }, { name: "", keywords: ["a"] }, { name: "r", keywords: [] }, { name: "r", keywords: ["x".repeat(51)] },
      { name: "r", keywords: Array.from({ length: 101 }, (_, i) => `k${i}`) }, { name: "r", keywords: ["a\u0007"] }, { name: "r", keywords: ["..."] },
      { name: "r", keywords: ["a"], regex: ".*" },
    ];
    for (const body of bad) expect((await call("POST", `${s.base}/automod/rules`, s.owner.token, body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await call("PATCH", `${s.base}/automod/rules/${s.rule.id}`, s.owner.token, {})).statusCode).toBe(400);
  });
});

describe("enforcement", () => {
  it("blocks a matching message with a fixed 403 and stores nothing of it", async () => {
    const s = await setup();
    const file = await uploadAttachment(app, s.member.token, { channelId: s.general.id });
    const res = await call("POST", `/channels/${s.general.id}/messages`, s.member.token, {
      content: `<@${s.owner.id}> ĐỒ NGỐC! see https://example.com/x`,
      attachmentIds: [file.id],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: AUTOMOD_BLOCKED }); // no hint of the keyword
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.messageMention.count()).toBe(0);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: file.id } })).messageId).toBeNull(); // still the sender's, unclaimed
    await new Promise((r) => setTimeout(r, 100));
    expect(pageCalls).toEqual([]); // no link preview fetched
    expect((await call("GET", "/me/unread", s.owner.token)).json().channels).toEqual([]);
    // a message that does not match goes through (and its link is fetched)
    expect((await send(s, s.member.token, "class act, see https://example.com/y")).statusCode).toBe(201);
    await vi.waitFor(() => expect(pageCalls).toEqual(["https://example.com/y"])); // proves the "nothing fetched" above could fail
  });

  it("is whole words / phrases on folded text", async () => {
    const s = await setup();
    const cases: [string, number][] = [["do ngoc", 403], ["Đồ-ngốc", 403], ["đồngốc", 201], ["đồ ngốc1", 201], ["SPAM, link", 403], ["spam links", 201]];
    for (const [content, status] of cases) expect((await send(s, s.member.token, content)).statusCode, content).toBe(status);
  });

  it("exempts the owner, ADMINISTRATOR and MANAGE_MESSAGES in that channel; a disabled rule blocks nobody", async () => {
    const s = await setup();
    for (const who of [s.owner, s.admin, s.mod]) expect((await send(s, who.token, "đồ ngốc")).statusCode, who.name).toBe(201);
    // MANAGE_MESSAGES given in one channel only exempts there
    const other = (await call("POST", `${s.base}/channels`, s.owner.token, { name: "other", type: "TEXT" })).json() as { id: string };
    const role = await makeRole(s.guild.id, 1, 0, [s.member.id]);
    await call("PUT", `/channels/${other.id}/overwrites/${role.id}`, s.owner.token, { allow: P.MANAGE_MESSAGES, deny: 0 });
    expect((await send(s, s.member.token, "đồ ngốc", other.id)).statusCode).toBe(201);
    expect((await send(s, s.member.token, "đồ ngốc")).statusCode).toBe(403);
    await call("PATCH", `${s.base}/automod/rules/${s.rule.id}`, s.owner.token, { enabled: false });
    expect((await send(s, s.member.token, "đồ ngốc")).statusCode).toBe(201);
  });

  it("an edit to a blocked word is refused and the old text stays", async () => {
    const s = await setup();
    const msg = (await send(s, s.member.token, "fine")).json() as { id: string };
    const res = await call("PATCH", `/messages/${msg.id}`, s.member.token, { content: "nay đồ ngốc" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: AUTOMOD_BLOCKED });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: msg.id } })).content).toBe("fine");
  });

  it("covers threads; DMs and attachment file names are not checked", async () => {
    const s = await setup();
    const starter = (await send(s, s.member.token, "start")).json() as { id: string };
    const thread = (await call("POST", `/channels/${s.general.id}/messages/${starter.id}/thread`, s.member.token, { name: "t" })).json() as { id: string };
    expect((await send(s, s.member.token, "đồ ngốc", thread.id)).statusCode).toBe(403);
    await befriend(app, s.member, s.friend);
    const dm = (await call("POST", "/dms", s.member.token, { userId: s.friend.id })).json() as { id: string };
    expect((await call("POST", `/dms/${dm.id}/messages`, s.member.token, { content: "đồ ngốc" })).statusCode).toBe(201);
    const file = await uploadAttachment(app, s.member.token, { channelId: s.general.id }, undefined, { filename: "đồ ngốc.png" });
    expect((await call("POST", `/channels/${s.general.id}/messages`, s.member.token, { attachmentIds: [file.id] })).statusCode).toBe(201);
  });

  it("logs blocks at most once per user and rule per minute", async () => {
    const s = await setup();
    const second = (await call("POST", `${s.base}/automod/rules`, s.owner.token, { name: "More", keywords: ["boo"] })).json() as { id: string };
    for (let i = 0; i < 5; i++) await send(s, s.member.token, "đồ ngốc");
    await send(s, s.member.token, "boo");
    await send(s, s.mod.token, "đồ ngốc"); // exempt: no block, no entry
    const blocks = () => prisma.auditLog.findMany({ where: { action: "automod.block" }, orderBy: { createdAt: "asc" } });
    expect((await blocks()).map((e) => [e.targetUserId, e.targetId, e.actorId])).toEqual([[s.member.id, s.rule.id, null], [s.member.id, second.id, null]]);
    expect((await blocks())[0]!.metadata).toEqual({ rule: "Words", channelId: s.general.id });
    await prisma.auditLog.updateMany({ where: { action: "automod.block" }, data: { createdAt: new Date(Date.now() - 61_000) } });
    await send(s, s.member.token, "đồ ngốc");
    expect(await blocks()).toHaveLength(3);
  });

  it("folds text exactly like the search index's loop_fold", async () => {
    const letters = "AÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬEÈÉẺẼẸÊỀẾỂỄỆIÌÍỈĨỊOÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢUÙÚỦŨỤƯỪỨỬỮỰYỲÝỶỸỴĐ";
    const text = `${letters} ${letters.toLowerCase()} ÇÑÜßæ`;
    const [row] = await prisma.$queryRaw<{ f: string }[]>`SELECT loop_fold(${text}) AS f`;
    expect(foldText(text)).toBe(row!.f);
  });
});
