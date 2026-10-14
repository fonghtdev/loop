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

/** alice and bob are friends with a DM; carol is a stranger. */
async function setup() {
  const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
  await befriend(app, a, b);
  const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json() as { id: string };
  return { a, b, c, dm, url: `/dms/${dm.id}/messages` };
}
const send = async (u: U, url: string, content: string) => (await call("POST", url, u.token, { content })).json();
const history = async (u: U, url: string, query = "") =>
  (await call("GET", `${url}${query}`, u.token)).json().messages as { id: string; seq: string; content: string }[];

describe("open a DM", () => {
  it("friends only; 201 then 200 with the same id; both sides can open it", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const first = await call("POST", "/dms", a.token, { userId: b.id });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ id: expect.any(String), user: { id: b.id, username: "bob", online: false } });
    const again = await call("POST", "/dms", a.token, { userId: b.id });
    const theirs = await call("POST", "/dms", b.token, { userId: a.id });
    expect([again.statusCode, theirs.statusCode]).toEqual([200, 200]);
    expect([again.json().id, theirs.json().id]).toEqual([first.json().id, first.json().id]);
    expect(theirs.json().user.username).toBe("alice");
  });

  it("concurrent opens, from both sides, create exactly one channel", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const res = await Promise.all([a, b, a, b, a, b].map((u, i) => call("POST", "/dms", u.token, { userId: (i % 2 ? a : b).id })));
    expect(new Set(res.map((r) => r.json().id)).size).toBe(1);
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await prisma.dmChannel.count()).toBe(1);
  });

  it("not a friend, pending, unknown, malformed, blocked: all the same 404; yourself 400", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await call("POST", "/friends/requests", a.token, { username: "bob" }); // pending only
    const open = (u: U, userId: string) => call("POST", "/dms", u.token, { userId });
    const unknown = await open(a, "00000000-0000-4000-8000-000000000000");
    expect(unknown.statusCode).toBe(404);
    for (const res of [await open(a, c.id), await open(a, b.id), await open(a, "nope")]) expect(res.body).toBe(unknown.body);
    expect((await open(a, a.id)).statusCode).toBe(400);
    expect((await call("POST", "/dms", a.token, {})).statusCode).toBe(400);
    await befriend(app, a, c);
    await call("PUT", `/blocks/${a.id}`, c.token);
    expect((await open(a, c.id)).body).toBe(unknown.body);
    expect((await open(c, a.id)).body).toBe(unknown.body);
    expect(await prisma.dmChannel.count()).toBe(0);
  });

  it("GET /dms lists my channels by last activity, never someone else's", async () => {
    const [a, b, c, d] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol"), signUp("dave")]);
    await befriend(app, a, b);
    await befriend(app, a, c);
    await befriend(app, c, d);
    const ab = (await call("POST", "/dms", a.token, { userId: b.id })).json();
    const ac = (await call("POST", "/dms", a.token, { userId: c.id })).json();
    await call("POST", "/dms", c.token, { userId: d.id });
    expect((await call("GET", "/dms", a.token)).json().map((x: { id: string }) => x.id)).toEqual([ac.id, ab.id]); // newest empty first
    await send(b, `/dms/${ab.id}/messages`, "bump");
    const list = (await call("GET", "/dms", a.token)).json();
    expect(list.map((x: { id: string }) => x.id)).toEqual([ab.id, ac.id]);
    expect(list[0]).toMatchObject({ user: { id: b.id, username: "bob", online: false }, lastMessageAt: expect.any(String) });
    expect(list[1].lastMessageAt).toBeNull();
    expect((await call("GET", "/dms", d.token)).json()).toHaveLength(1);
  });
});

describe("messages", () => {
  it("send, history, edit own, delete own; DTO has dmChannelId and no channelId", async () => {
    const { a, b, dm, url } = await setup();
    const res = await call("POST", url, a.token, { content: "  hi  " });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg).toMatchObject({ channelId: null, dmChannelId: dm.id, content: "hi", editedAt: null, author: { id: a.id, username: "alice" } });
    expect(Object.keys(msg.author).sort()).toEqual(["id", "isBot", "username"]);
    expect(typeof msg.seq).toBe("string");
    await send(b, url, "yo");
    expect((await history(b, url)).map((m) => m.content)).toEqual(["hi", "yo"]);

    const edited = await call("PATCH", `/messages/${msg.id}`, a.token, { content: "hi!" });
    expect(edited.json()).toMatchObject({ content: "hi!", dmChannelId: dm.id });
    expect(edited.json().editedAt).not.toBeNull();
    expect((await call("DELETE", `/messages/${msg.id}`, a.token)).statusCode).toBe(204);
    expect((await history(a, url)).map((m) => m.content)).toEqual(["yo"]);
  });

  it("content rules match guild messages (400 on empty / too long / NUL)", async () => {
    const { a, url } = await setup();
    for (const content of ["", "   ", "x".repeat(2001), "a\0b", 5]) {
      expect((await call("POST", url, a.token, { content })).statusCode, JSON.stringify(content)).toBe(400);
    }
    expect((await call("POST", url, a.token, { content: "x".repeat(2000) })).statusCode).toBe(201);
  });

  it("a non-participant gets 404 on every DM route and on edit/delete of a DM message", async () => {
    const { a, c, dm, url } = await setup();
    const msg = await send(a, url, "secret");
    const ghost = "/dms/00000000-0000-4000-8000-000000000000/messages";
    for (const path of [url, ghost, "/dms/nope/messages"]) {
      expect((await call("GET", path, c.token)).statusCode).toBe(404);
      expect((await call("POST", path, c.token, { content: "x" })).statusCode).toBe(404);
    }
    expect((await call("PATCH", `/messages/${msg.id}`, c.token, { content: "x" })).statusCode).toBe(404);
    expect((await call("DELETE", `/messages/${msg.id}`, c.token)).statusCode).toBe(404);
    expect((await history(a, url)).map((m) => m.content)).toEqual(["secret"]);
    expect((await call("GET", "/dms", c.token)).json()).toEqual([]);
    expect(dm.id).toBeTruthy();
  });

  it("the other participant cannot edit or delete my message (403), nobody moderates DMs", async () => {
    const { a, b, url } = await setup();
    const msg = await send(a, url, "mine");
    expect((await call("PATCH", `/messages/${msg.id}`, b.token, { content: "x" })).statusCode).toBe(403);
    expect((await call("DELETE", `/messages/${msg.id}`, b.token)).statusCode).toBe(403);
    expect((await history(a, url)).map((m) => m.content)).toEqual(["mine"]);
  });

  it("after unfriend or block: sending is 403 (same body), history stays readable, own edit/delete still work", async () => {
    const { a, b, url } = await setup();
    const kept = await send(a, url, "kept");
    const gone = await send(a, url, "gone");

    await call("DELETE", `/friends/${b.id}`, a.token);
    const unfriended = await call("POST", url, b.token, { content: "x" });
    expect(unfriended.statusCode).toBe(403);
    expect((await call("POST", url, a.token, { content: "x" })).statusCode).toBe(403);
    expect((await history(b, url)).map((m) => m.content)).toEqual(["kept", "gone"]);
    expect((await call("PATCH", `/messages/${kept.id}`, a.token, { content: "kept!" })).statusCode).toBe(200);
    expect((await call("DELETE", `/messages/${gone.id}`, a.token)).statusCode).toBe(204);

    await befriend(app, a, b);
    expect((await call("POST", url, a.token, { content: "back" })).statusCode).toBe(201);
    await call("PUT", `/blocks/${a.id}`, b.token);
    const blocked = await call("POST", url, a.token, { content: "x" });
    expect(blocked.body).toBe(unfriended.body);
    expect((await call("POST", url, b.token, { content: "x" })).statusCode).toBe(403);
    expect((await history(a, url)).map((m) => m.content)).toEqual(["kept!", "back"]);
  });

  it("history paging: before / after / limit, ascending, same as guild history", async () => {
    const { a, b, url } = await setup();
    const sent: { seq: string; content: string }[] = [];
    for (let i = 0; i < 7; i++) sent.push(await send(i % 2 ? b : a, url, `m${i}`));
    const text = (ms: { content: string }[]) => ms.map((m) => m.content);
    expect(text(await history(a, url, "?limit=3"))).toEqual(["m4", "m5", "m6"]);
    expect(text(await history(a, url, `?before=${sent[4]!.seq}&limit=2`))).toEqual(["m2", "m3"]);
    expect(text(await history(a, url, `?after=${sent[4]!.seq}&limit=1`))).toEqual(["m5"]);
    expect(text(await history(b, url, `?after=${sent[1]!.seq}`))).toEqual(["m2", "m3", "m4", "m5", "m6"]);
    expect((await call("GET", `${url}?before=1&after=2`, a.token)).statusCode).toBe(400);
    expect((await call("GET", `${url}?limit=0`, a.token)).statusCode).toBe(400);
  });

  it("DM messages never show up in a guild channel and vice versa", async () => {
    const { a, b, url } = await setup();
    const { general } = await guildWith(app, a, b);
    await send(a, url, "dm only");
    await send(a, `/channels/${general.id}/messages`, "guild only");
    expect((await history(a, url)).map((m) => m.content)).toEqual(["dm only"]);
    expect((await history(a, `/channels/${general.id}/messages`)).map((m) => m.content)).toEqual(["guild only"]);
  });
});

describe("database guards", () => {
  const insert = (channelId: string | null, dmChannelId: string | null, authorId: string) =>
    prisma.$executeRaw`INSERT INTO "Message" (id, "channelId", "dmChannelId", "authorId", content) VALUES (gen_random_uuid(), ${channelId}::uuid, ${dmChannelId}::uuid, ${authorId}::uuid, 'x')`;

  it("a message needs exactly one of channelId / dmChannelId", async () => {
    const { a, dm } = await setup();
    const { general } = await guildWith(app, a);
    await expect(insert(general.id, dm.id, a.id)).rejects.toThrow(/Message_one_target_check/);
    await expect(insert(null, null, a.id)).rejects.toThrow(/Message_one_target_check/);
    await expect(insert(null, dm.id, a.id)).resolves.toBe(1);
    await expect(insert(general.id, null, a.id)).resolves.toBe(1);
  });

  it("pairs must be ordered and unique; no self block", async () => {
    const { a, b } = await setup();
    const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await expect(prisma.$executeRaw`INSERT INTO "DmChannel" (id, "userLowId", "userHighId") VALUES (gen_random_uuid(), ${high}::uuid, ${low}::uuid)`).rejects.toThrow(/pair_order/);
    await expect(prisma.$executeRaw`INSERT INTO "DmChannel" (id, "userLowId", "userHighId") VALUES (gen_random_uuid(), ${low}::uuid, ${high}::uuid)`).rejects.toThrow(/already exists/);
    await expect(prisma.$executeRaw`INSERT INTO "Friendship" ("userLowId", "userHighId", "requesterId", status) VALUES (${high}::uuid, ${low}::uuid, ${low}::uuid, 'PENDING')`).rejects.toThrow(/pair_order/);
    await expect(prisma.$executeRaw`INSERT INTO "Block" ("blockerId", "blockedId") VALUES (${a.id}::uuid, ${a.id}::uuid)`).rejects.toThrow(/not_self/);
  });
});
