import { Permission as P } from "@loop/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, guildWith, resetDb, signUp as signUpUser } from "../../test/helpers.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
type U = Awaited<ReturnType<typeof signUp>>;

beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const say = async (u: U, channelId: string, content: string) => (await call("POST", `/channels/${channelId}/messages`, u.token, { content })).json() as { id: string };
const find = async (u: U, guildId: string, query: Record<string, string | number>) => {
  const res = await call("GET", `/guilds/${guildId}/messages/search?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`, u.token);
  return { status: res.statusCode, body: res.json() as { messages: { id: string; content: string; channelId: string; author: { id: string } }[]; hasMore: boolean } };
};
const contents = (r: { body: { messages: { content: string }[] } }) => r.body.messages.map((m) => m.content);

async function setup() {
  const [alice, bob] = await Promise.all(["alice", "bob"].map(signUp));
  const { guild, general } = await guildWith(app, alice, bob);
  const other = (await call("POST", `/guilds/${guild.id}/channels`, alice.token, { name: "other", type: "TEXT" })).json() as { id: string };
  return { alice, bob, guild, general, other };
}

describe("guild message search", () => {
  it("finds text newest first, with the full message JSON", async () => {
    const { alice, guild, general } = await setup();
    await say(alice, general.id, "deploy the server");
    await say(alice, general.id, "unrelated");
    await say(alice, general.id, "server is down");
    const r = await find(alice, guild.id, { q: "server" });
    expect(contents(r)).toEqual(["server is down", "deploy the server"]);
    expect(r.body.hasMore).toBe(false);
    expect(r.body.messages[0]).toMatchObject({ channelId: general.id, seq: expect.any(String), author: { id: alice.id }, attachments: [], reactions: [] });
  });

  it("ignores accents and case, and matches prefixes (Vietnamese)", async () => {
    const { alice, guild, general } = await setup();
    await say(alice, general.id, "Xin chào các bạn");
    await say(alice, general.id, "Đạt đã tới");
    await say(alice, general.id, "NGUYỄN văn A");
    expect(contents(await find(alice, guild.id, { q: "xin chao" }))).toEqual(["Xin chào các bạn"]);
    expect(contents(await find(alice, guild.id, { q: "xin chào" }))).toEqual(["Xin chào các bạn"]);
    expect(contents(await find(alice, guild.id, { q: "dat" }))).toEqual(["Đạt đã tới"]);
    expect(contents(await find(alice, guild.id, { q: "Đạt" }))).toEqual(["Đạt đã tới"]);
    expect(contents(await find(alice, guild.id, { q: "nguyen" }))).toEqual(["NGUYỄN văn A"]);
    expect(contents(await find(alice, guild.id, { q: "xin ch" }))).toEqual(["Xin chào các bạn"]);
    expect(contents(await find(alice, guild.id, { q: "chào xin" })), "word order does not matter").toEqual(["Xin chào các bạn"]);
    expect(contents(await find(alice, guild.id, { q: "chao dat" })), "all terms must match").toEqual([]);
  });

  it("matches text typed with decomposed (NFD) accents", async () => {
    const { alice, guild, general } = await setup();
    await say(alice, general.id, "chào".normalize("NFD"));
    expect(contents(await find(alice, guild.id, { q: "chao" }))).toHaveLength(1);
    expect(contents(await find(alice, guild.id, { q: "chào".normalize("NFD") }))).toHaveLength(1);
  });

  it("never leaks messages or the existence of channels the caller cannot VIEW", async () => {
    const { alice, bob, guild, general, other } = await setup();
    await call("PUT", `/channels/${other.id}/overwrites/${guild.id}`, alice.token, { allow: 0, deny: P.VIEW_CHANNEL });
    await say(alice, general.id, "needle public");
    await say(alice, other.id, "needle hidden");
    expect(contents(await find(bob, guild.id, { q: "needle" }))).toEqual(["needle public"]);
    expect(contents(await find(alice, guild.id, { q: "needle" })).sort()).toEqual(["needle hidden", "needle public"]);
    const asked = await find(bob, guild.id, { q: "needle", channelId: other.id });
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({ messages: [], hasMore: false });
    expect(await find(bob, guild.id, { authorId: alice.id }).then(contents)).toEqual(["needle public"]);
    await call("DELETE", `/channels/${other.id}/overwrites/${guild.id}`, alice.token);
    expect(contents(await find(bob, guild.id, { q: "needle" })).sort()).toEqual(["needle hidden", "needle public"]);
  });

  it("is a 404 for non-members and does not search other guilds", async () => {
    const { alice, guild, general } = await setup();
    const outsider = await signUp("outsider");
    const elsewhere = await guildWith(app, outsider);
    await say(alice, general.id, "needle");
    await say(outsider, elsewhere.general.id, "needle abroad");
    expect((await find(outsider, guild.id, { q: "needle" })).status).toBe(404);
    expect(contents(await find(alice, guild.id, { q: "needle" }))).toEqual(["needle"]);
  });

  it("filters by author and channel, alone or with text", async () => {
    const { alice, bob, guild, general, other } = await setup();
    await say(alice, general.id, "alpha one");
    await say(bob, general.id, "alpha two");
    await say(bob, other.id, "beta three");
    expect(contents(await find(alice, guild.id, { authorId: bob.id }))).toEqual(["beta three", "alpha two"]);
    expect(contents(await find(alice, guild.id, { authorId: bob.id, q: "alpha" }))).toEqual(["alpha two"]);
    expect(contents(await find(alice, guild.id, { q: "alpha", channelId: other.id }))).toEqual([]);
    expect(contents(await find(alice, guild.id, { channelId: other.id, authorId: bob.id }))).toEqual(["beta three"]);
  });

  it("pages with before and hasMore", async () => {
    const { alice, guild, general } = await setup();
    for (let i = 1; i <= 7; i++) await say(alice, general.id, `page ${i}`);
    const first = await find(alice, guild.id, { q: "page", limit: 3 });
    expect([contents(first), first.body.hasMore]).toEqual([["page 7", "page 6", "page 5"], true]);
    const seq = (await prisma.message.findUniqueOrThrow({ where: { id: first.body.messages[2]!.id } })).seq;
    const second = await find(alice, guild.id, { q: "page", limit: 3, before: String(seq) });
    expect([contents(second), second.body.hasMore]).toEqual([["page 4", "page 3", "page 2"], true]);
    const seq2 = (await prisma.message.findUniqueOrThrow({ where: { id: second.body.messages[2]!.id } })).seq;
    const last = await find(alice, guild.id, { q: "page", limit: 3, before: String(seq2) });
    expect([contents(last), last.body.hasMore]).toEqual([["page 1"], false]);
  });

  it("validates the query strictly", async () => {
    const { alice, guild } = await setup();
    const bad: Record<string, string | number>[] = [{}, { q: "" }, { q: "   " }, { q: "x".repeat(101) }, { q: "a", limit: 0 }, { q: "a", limit: 26 }, { q: "a", before: "abc" }, { authorId: "nope" }, { q: "a", channelId: "nope" }, { q: "a", extra: 1 }];
    for (const q of bad) expect((await find(alice, guild.id, q)).status, JSON.stringify(q)).toBe(400);
    expect((await find(alice, guild.id, { q: "x".repeat(100) })).status).toBe(200);
    expect((await call("GET", `/guilds/${guild.id}/messages/search?q=a%00b`, alice.token)).statusCode).toBe(400);
  });

  it("treats tsquery syntax and SQL as plain text, never as an error", async () => {
    const { alice, guild, general } = await setup();
    await say(alice, general.id, "cats and dogs");
    await say(alice, general.id, "tom & jerry's \"quoted\" (parens) !not");
    const hostile = ["cats | dogs", "cats & !dogs", "cats:*", "(((", "'", "\"", "\\", "a <-> b", "!!", "cats'); DROP TABLE \"Message\"; --", "%", "_", "*", ":", "&&&", "'\" | ! & ( ) : * \\ <->", "𝒳", "٣", "ß", "ǅ"];
    for (const q of hostile) expect((await find(alice, guild.id, { q })).status, q).toBe(200);
    expect(contents(await find(alice, guild.id, { q: "cats | dogs" }))).toEqual(["cats and dogs"]); // words, not an operator
    expect(contents(await find(alice, guild.id, { q: "cats & !dogs" }))).toEqual(["cats and dogs"]);
    expect(contents(await find(alice, guild.id, { q: "!!!" })), "no searchable word").toEqual([]);
    expect(await prisma.message.count()).toBe(2);
  });

  it("includes the reply preview like the history does", async () => {
    const { alice, guild, general } = await setup();
    const m = await say(alice, general.id, "base text");
    await call("POST", `/channels/${general.id}/messages`, alice.token, { content: "reply text", replyToId: m.id });
    const r = await find(alice, guild.id, { q: "reply" });
    expect(r.body.messages[0]).toMatchObject({ replyTo: { id: m.id, deleted: false } });
  });
});

describe("DM message search", () => {
  it("searches one DM for its participants only, also after an unfriend", async () => {
    const { alice, bob } = await setup();
    const carol = await signUp("carol");
    await befriend(app, alice, bob);
    const dm = (await call("POST", "/dms", alice.token, { userId: bob.id })).json() as { id: string };
    await call("POST", `/dms/${dm.id}/messages`, alice.token, { content: "bí mật của Đạt" });
    await call("POST", `/dms/${dm.id}/messages`, bob.token, { content: "other" });
    const search = (u: U, q: string) => call("GET", `/dms/${dm.id}/messages/search?q=${encodeURIComponent(q)}`, u.token);
    const hit = (await search(bob, "bi mat dat")).json();
    expect(hit.messages.map((m: { content: string }) => m.content)).toEqual(["bí mật của Đạt"]);
    expect(hit.messages[0]).toMatchObject({ dmChannelId: dm.id, channelId: null });
    expect((await search(carol, "bí")).statusCode).toBe(404);
    expect((await call("GET", `/dms/${dm.id}/messages/search`, alice.token)).statusCode, "q is required").toBe(400);
    await call("DELETE", `/friends/${bob.id}`, alice.token);
    expect((await search(alice, "other")).json().messages).toHaveLength(1);
  });

  it("does not search guild messages or other DMs", async () => {
    const { alice, bob, general } = await setup();
    const carol = await signUp("carol");
    await befriend(app, alice, bob);
    await befriend(app, alice, carol);
    const dmBob = (await call("POST", "/dms", alice.token, { userId: bob.id })).json() as { id: string };
    const dmCarol = (await call("POST", "/dms", alice.token, { userId: carol.id })).json() as { id: string };
    await say(alice, general.id, "needle guild");
    await call("POST", `/dms/${dmCarol.id}/messages`, alice.token, { content: "needle carol" });
    const r = (await call("GET", `/dms/${dmBob.id}/messages/search?q=needle`, alice.token)).json();
    expect(r).toEqual({ messages: [], hasMore: false });
  });
});
