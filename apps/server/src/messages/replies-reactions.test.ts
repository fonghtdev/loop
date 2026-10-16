import { io, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, resetDb, signUp as signUpUser } from "../../test/helpers.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
type U = Awaited<ReturnType<typeof signUp>>;
let port: number;
const sockets: Socket[] = [];

beforeAll(async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});
beforeEach(resetDb);
afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function setup() {
  const [owner, member, outsider] = await Promise.all([signUp("owner"), signUp("member"), signUp("outsider")]);
  const { guild, channels } = (await call("POST", "/guilds", owner.token, { name: "HQ" })).json();
  const code = (await call("POST", `/guilds/${guild.id}/invites`, owner.token, {})).json().code;
  await call("POST", `/invites/${code}/join`, member.token);
  const other = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "other", type: "TEXT" })).json();
  return { owner, member, outsider, channel: channels[0], url: `/channels/${channels[0].id}/messages`, otherUrl: `/channels/${other.id}/messages` };
}
const post = async (u: U, url: string, body: object) => call("POST", url, u.token, body);
const react = (u: U, id: string, emoji: string, method: "PUT" | "DELETE" = "PUT") => call(method, `/messages/${id}/reactions/${encodeURIComponent(emoji)}`, u.token);
const page = async (u: U, url: string) => (await call("GET", url, u.token)).json().messages as any[];

describe("reply", () => {
  it("a reply carries a compact preview of its target; the target has none", async () => {
    const { owner, member, url } = await setup();
    const target = (await post(owner, url, { content: "x".repeat(300) })).json();
    expect(target.replyTo).toBeNull();
    const res = await post(member, url, { content: "answer", replyToId: target.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().replyTo).toEqual({
      id: target.id,
      author: { id: owner.id, username: "owner", isBot: false, displayName: null, avatarHash: null },
      content: "x".repeat(140),
      hasAttachments: false,
      deleted: false,
    });
    expect((await page(member, url)).map((m) => m.replyTo?.id ?? null)).toEqual([null, target.id]);
  });

  it("400 (same body) for an unknown, malformed, other-channel and DM target; nothing is created", async () => {
    const { owner, url, otherUrl } = await setup();
    const elsewhere = (await post(owner, otherUrl, { content: "other channel" })).json();
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json();
    const inDm = (await post(a, `/dms/${dm.id}/messages`, { content: "private" })).json();
    const bodies = new Set<string>();
    for (const replyToId of [elsewhere.id, inDm.id, "00000000-0000-4000-8000-000000000000", "nope"]) {
      const res = await post(owner, url, { content: "x", replyToId });
      expect(res.statusCode).toBe(400);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
    expect(await page(owner, url)).toEqual([]);
    expect((await post(a, `/dms/${dm.id}/messages`, { content: "x", replyToId: elsewhere.id })).statusCode).toBe(400);
  });

  it("works in a DM, and a deleted target shows as { id, deleted: true } on history", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json();
    const url = `/dms/${dm.id}/messages`;
    const target = (await post(a, url, { content: "first" })).json();
    const reply = (await post(b, url, { content: "re", replyToId: target.id })).json();
    expect(reply.replyTo).toMatchObject({ id: target.id, content: "first", deleted: false });
    await call("DELETE", `/messages/${target.id}`, a.token);
    const [only] = await page(b, url);
    expect(only.replyTo).toEqual({ id: target.id, deleted: true });
  });

  it("an attachment-only target reports hasAttachments", async () => {
    const { owner, url } = await setup();
    const target = (await post(owner, url, { content: "pic" })).json();
    const att = await prisma.attachment.create({
      data: { uploaderId: owner.id, channelId: target.channelId, messageId: target.id, filename: "a.png", contentType: "image/png", size: 1, objectKey: "k", status: "READY" },
    });
    expect(att.id).toBeTruthy();
    const reply = (await post(owner, url, { content: "r", replyToId: target.id })).json();
    expect(reply.replyTo.hasAttachments).toBe(true);
  });
});

describe("reactions", () => {
  it("add is idempotent (204), counts and `me` are per viewer, remove is idempotent", async () => {
    const { owner, member, url } = await setup();
    const msg = (await post(owner, url, { content: "hi" })).json();
    expect(msg.reactions).toEqual([]);
    expect((await react(owner, msg.id, "👍")).statusCode).toBe(204);
    expect((await react(owner, msg.id, "👍")).statusCode).toBe(204);
    expect((await react(member, msg.id, "👍")).statusCode).toBe(204);
    expect((await react(member, msg.id, "🇻🇳")).statusCode).toBe(204);
    expect((await page(owner, url))[0].reactions).toEqual([{ emoji: "👍", count: 2, me: true }, { emoji: "🇻🇳", count: 1, me: false }]);
    expect((await page(member, url))[0].reactions).toEqual([{ emoji: "👍", count: 2, me: true }, { emoji: "🇻🇳", count: 1, me: true }]);
    expect((await react(member, msg.id, "🇻🇳", "DELETE")).statusCode).toBe(204);
    expect((await react(member, msg.id, "🇻🇳", "DELETE")).statusCode).toBe(204);
    expect((await page(owner, url))[0].reactions).toEqual([{ emoji: "👍", count: 2, me: true }]);
    expect(await prisma.reaction.count()).toBe(2);
  });

  it("an edit response keeps the editor's `me`; deleting the message removes its reactions", async () => {
    const { owner, url } = await setup();
    const msg = (await post(owner, url, { content: "hi" })).json();
    await react(owner, msg.id, "🔥");
    const edited = (await call("PATCH", `/messages/${msg.id}`, owner.token, { content: "hi!" })).json();
    expect(edited.reactions).toEqual([{ emoji: "🔥", count: 1, me: true }]);
    await call("DELETE", `/messages/${msg.id}`, owner.token);
    expect(await prisma.reaction.count()).toBe(0);
  });

  it("400 on anything but a single emoji", async () => {
    const { owner, url } = await setup();
    const msg = (await post(owner, url, { content: "hi" })).json();
    for (const bad of ["a", "ab", "👍👍", "<b>", "1", "x".repeat(40)]) expect((await react(owner, msg.id, bad)).statusCode, bad).toBe(400);
    for (const good of ["👍🏽", "1️⃣", "👨‍👩‍👧‍👦"]) expect((await react(owner, msg.id, good)).statusCode, good).toBe(204);
  });

  it("at most 20 distinct emoji per message, from any users; an existing one can still be joined", async () => {
    const { owner, member, url } = await setup();
    const msg = (await post(owner, url, { content: "hi" })).json();
    const emoji = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x1f600 + i));
    for (const e of emoji) expect((await react(owner, msg.id, e)).statusCode).toBe(204);
    expect((await react(member, msg.id, String.fromCodePoint(0x1f700))).statusCode).toBe(400);
    expect((await react(owner, msg.id, String.fromCodePoint(0x1f700))).statusCode).toBe(400);
    expect((await react(member, msg.id, emoji[0]!)).statusCode).toBe(204);
    expect((await page(owner, url))[0].reactions).toHaveLength(20);
  });

  it("404 for outsiders, unknown and malformed message ids", async () => {
    const { owner, outsider, url } = await setup();
    const msg = (await post(owner, url, { content: "hi" })).json();
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) expect((await react(owner, id, "👍")).statusCode).toBe(404);
    expect((await react(outsider, msg.id, "👍")).statusCode).toBe(404);
    expect((await react(outsider, msg.id, "👍", "DELETE")).statusCode).toBe(404);
  });

  it("DM: participants react; a stranger gets 404; after an unfriend adding is 403 but taking back works", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await befriend(app, a, b);
    const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json();
    const url = `/dms/${dm.id}/messages`;
    const msg = (await post(a, url, { content: "hi" })).json();
    expect((await react(b, msg.id, "❤️")).statusCode).toBe(204);
    expect((await react(c, msg.id, "❤️")).statusCode).toBe(404);
    expect((await page(a, url))[0].reactions).toEqual([{ emoji: "❤️", count: 1, me: false }]);
    await call("DELETE", `/friends/${b.id}`, a.token);
    expect((await react(a, msg.id, "👍")).statusCode).toBe(403);
    expect((await react(b, msg.id, "👍")).statusCode).toBe(403);
    expect((await react(b, msg.id, "❤️", "DELETE")).statusCode).toBe(204);
  });
});

describe("reaction events", () => {
  async function connect(token: string) {
    const s = io(`http://127.0.0.1:${port}`, { auth: { token }, reconnection: false, forceNew: true }) as Socket & { got: any[] };
    s.got = [];
    s.onAny((event, p) => event.includes("reaction") && s.got.push([event, p]));
    sockets.push(s);
    await new Promise<void>((resolve, reject) => (s.once("connect", resolve), s.once("connect_error", reject)));
    return s;
  }
  const until = (check: () => unknown) => vi.waitFor(() => expect(check()).toBeTruthy(), { timeout: 2000, interval: 10 });

  it("channel subscribers get { messageId, channelId, emoji, userId, added, count } for each real change only", async () => {
    const { owner, member, outsider, channel, url } = await setup();
    const [a, o] = await Promise.all([connect(owner.token), connect(outsider.token)]);
    await a.emitWithAck("channel:subscribe", { channelId: channel.id });
    const msg = (await post(owner, url, { content: "hi" })).json();
    await react(member, msg.id, "👍");
    await react(member, msg.id, "👍"); // no change, no event
    await react(owner, msg.id, "👍");
    await react(member, msg.id, "👍", "DELETE");
    await until(() => a.got.length === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.got).toEqual([
      ["message:reaction", { messageId: msg.id, channelId: channel.id, emoji: "👍", userId: member.id, added: true, count: 1 }],
      ["message:reaction", { messageId: msg.id, channelId: channel.id, emoji: "👍", userId: owner.id, added: true, count: 2 }],
      ["message:reaction", { messageId: msg.id, channelId: channel.id, emoji: "👍", userId: member.id, added: false, count: 1 }],
    ]);
    expect(o.got).toEqual([]);
  });

  it("both DM participants get dm:message:reaction", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json();
    const [sa, sb] = await Promise.all([connect(a.token), connect(b.token)]);
    const msg = (await post(a, `/dms/${dm.id}/messages`, { content: "hi" })).json();
    await react(b, msg.id, "🔥");
    await until(() => sa.got.length && sb.got.length);
    const expected = [["dm:message:reaction", { messageId: msg.id, dmChannelId: dm.id, emoji: "🔥", userId: b.id, added: true, count: 1 }]];
    expect(sa.got).toEqual(expected);
    expect(sb.got).toEqual(expected);
  });
});
