import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Permission as P } from "@loop/shared";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, makeRole, resetDb, signUp as signUpUser, uploadAttachment } from "../../test/helpers.js";
import { connect as connectTo, listen, settle, until } from "../../test/sockets.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
type U = Awaited<ReturnType<typeof signUp>>;
type Ack = { ok: boolean; error?: string };
let port: number;
const sockets: Socket[] = [];

beforeAll(async () => {
  port = await listen(app);
});
beforeEach(resetDb);
afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const EVENTS = ["message:new", "thread:created", "thread:updated", "thread:deleted", "mention:new", "typing"];
const connect = (u: U) => connectTo(port, u.token, EVENTS, sockets);
const subscribe = (s: Socket, channelId: string) => s.emitWithAck("channel:subscribe", { channelId }) as Promise<Ack>;
const send = async (u: U, channelId: string, content: string) => call("POST", `/channels/${channelId}/messages`, u.token, { content });
const post = async (u: U, channelId: string, content: string) => (await send(u, channelId, content)).json() as { id: string; seq: string; channelId: string };
const startThread = (u: U, channelId: string, messageId: string, name = "plans") => call("POST", `/channels/${channelId}/messages/${messageId}/thread`, u.token, { name });
const history = async (u: U, channelId: string) => (await call("GET", `/channels/${channelId}/messages`, u.token)).json().messages as any[];
const unread = async (u: U) => (await call("GET", "/me/unread", u.token)).json() as { channels: any[] };

/**
 * owner; `insider` holds a role that may VIEW #secret; `carol` is a member who may not (@everyone is denied VIEW there).
 * A thread on #secret started by insider, and one on #general.
 */
async function setup() {
  const [owner, insider, carol, outsider] = await Promise.all(["owner", "insider", "carol", "outsider"].map(signUp));
  const { guild, general } = await guildWith(app, owner, insider, carol);
  const secret = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "secret", type: "TEXT" })).json() as { id: string };
  const role = await makeRole(guild.id, 1, 0, [insider.id]);
  await call("PUT", `/channels/${secret.id}/overwrites/${guild.id}`, owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
  await call("PUT", `/channels/${secret.id}/overwrites/${role.id}`, owner.token, { allow: P.VIEW_CHANNEL, deny: 0 });
  const starter = await post(insider, secret.id, "let's plan");
  const thread = (await startThread(insider, secret.id, starter.id)).json() as { id: string };
  return { owner, insider, carol, outsider, guild, general, secret, role, starter, thread };
}

describe("creating a thread", () => {
  it("starts one from a message of a text channel, with the agreed JSON", async () => {
    const [owner, member] = await Promise.all(["owner", "member"].map(signUp));
    const { guild, general } = await guildWith(app, owner, member);
    const starter = await post(owner, general.id, "topic");
    const res = await startThread(member, general.id, starter.id, "  Talk it over  ");
    expect(res.statusCode).toBe(201);
    const thread = res.json();
    expect(thread).toEqual({
      id: expect.any(String), guildId: guild.id, parentChannelId: general.id, name: "Talk it over", starterMessageId: starter.id,
      createdById: member.id, createdAt: expect.any(String), lastMessageAt: thread.createdAt, archived: false, messageCount: 0,
    });
    expect(Object.keys(thread).sort()).toEqual(["archived", "createdAt", "createdById", "guildId", "id", "lastMessageAt", "messageCount", "name", "parentChannelId", "starterMessageId"]);
  });

  it("allows one thread per message: a duplicate (even a racing one) is 409 with the existing thread's id", async () => {
    const [owner, member] = await Promise.all(["owner", "member"].map(signUp));
    const { general } = await guildWith(app, owner, member);
    const starter = await post(owner, general.id, "topic");
    const results = await Promise.all([startThread(owner, general.id, starter.id), startThread(member, general.id, starter.id), startThread(owner, general.id, starter.id)]);
    const created = results.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(1);
    for (const r of results.filter((r) => r.statusCode !== 201)) expect(r.statusCode === 409 && r.json()).toEqual({ error: "Thread already exists", threadId: created[0]!.json().id });
    expect(await prisma.channel.count({ where: { type: "THREAD" } })).toBe(1);
  });

  it("refuses a starter that is not a message of that channel, a thread inside a thread, a voice channel and a bad name", async () => {
    const { owner, insider, guild, general, secret, starter, thread } = await setup();
    const inThread = await post(insider, thread.id, "reply");
    const voice = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "talk", type: "VOICE" })).json();
    expect((await startThread(owner, general.id, starter.id)).statusCode, "starter of another channel").toBe(404);
    expect((await startThread(owner, secret.id, inThread.id)).statusCode, "a thread message is not a message of the parent").toBe(404);
    expect((await startThread(owner, thread.id, inThread.id)).json(), "no thread in a thread").toEqual({ error: "Threads cannot have threads" });
    expect((await startThread(owner, voice.id, starter.id)).json()).toEqual({ error: "Only text channels have threads" });
    expect((await startThread(owner, general.id, "not-a-uuid")).statusCode).toBe(404);
    expect((await startThread(owner, general.id, "00000000-0000-4000-8000-000000000000")).statusCode, "unknown / deleted starter").toBe(404);
    const plain = await post(owner, general.id, "x");
    for (const name of ["", "   ", "a".repeat(101), "bad‮name"]) expect((await startThread(owner, general.id, plain.id, name)).statusCode, JSON.stringify(name)).toBe(400);
    expect((await call("POST", `/channels/${general.id}/messages/${plain.id}/thread`, owner.token, { name: "x", extra: 1 })).statusCode, "strict body").toBe(400);
    expect((await startThread(owner, general.id, plain.id, "a".repeat(100))).statusCode).toBe(201);
  });

  it("needs VIEW (else 404) and SEND_MESSAGES (else 403) in the parent", async () => {
    const { owner, carol, guild, general, secret, starter } = await setup();
    expect((await startThread(carol, secret.id, starter.id)).statusCode, "parent hidden").toBe(404);
    const g = await post(owner, general.id, "g");
    await call("PUT", `/channels/${general.id}/overwrites/${guild.id}`, owner.token, { allow: 0, deny: P.SEND_MESSAGES });
    expect((await startThread(carol, general.id, g.id)).statusCode, "no SEND").toBe(403);
  });
});

describe("a thread's permissions are its parent's (one place: guilds/access.ts)", () => {
  it("gives a member who cannot VIEW the parent a 404 on every thread path, while a viewer gets through", async () => {
    const { insider, carol, guild, secret, thread } = await setup();
    const msg = await post(insider, thread.id, "in the thread");
    const file = await uploadAttachment(app, insider.token, { channelId: thread.id });
    const withFile = (await call("POST", `/channels/${thread.id}/messages`, insider.token, { attachmentIds: [file.id] })).json();
    const emoji = encodeURIComponent("👍");
    const paths: [string, string, object?][] = [
      ["GET", `/channels/${thread.id}/messages`],
      ["POST", `/channels/${thread.id}/messages`, { content: "hi" }],
      ["GET", `/channels/${thread.id}/pins`],
      ["PUT", `/channels/${thread.id}/read`, { seq: msg.seq }],
      ["GET", `/channels/${thread.id}/threads`],
      ["GET", `/channels/${secret.id}/threads`],
      ["PATCH", `/threads/${thread.id}`, { name: "mine now" }],
      ["PUT", `/messages/${msg.id}/reactions/${emoji}`],
      ["DELETE", `/messages/${msg.id}/reactions/${emoji}`],
      ["PUT", `/messages/${msg.id}/pin`],
      ["PATCH", `/messages/${msg.id}`, { content: "edited" }],
      ["POST", "/attachments", { filename: "a.png", contentType: "image/png", size: 10, channelId: thread.id }],
      ["GET", `/attachments/${withFile.attachments[0].id}`],
      ["DELETE", `/threads/${thread.id}`],
      ["DELETE", `/messages/${msg.id}`],
    ];
    for (const [method, url, body] of paths) expect((await call(method as never, url, carol.token, body)).statusCode, `${method} ${url}`).toBe(404);
    const s = await connect(carol);
    expect(await subscribe(s, thread.id)).toEqual({ ok: false, error: "Not found" });
    const search = (await call("GET", `/guilds/${guild.id}/messages/search?q=thread`, carol.token)).json();
    expect(search.messages, "search skips the hidden thread").toEqual([]);
    const searchById = (await call("GET", `/guilds/${guild.id}/messages/search?q=thread&channelId=${thread.id}`, carol.token)).json();
    expect(searchById).toEqual({ messages: [], hasMore: false });
    await unread(carol);
    await post(insider, thread.id, `hey <@${carol.id}>`);
    expect((await unread(carol)).channels, "no unread / mention for a hidden thread").toEqual([]);
    expect((await prisma.messageMention.count({ where: { userId: carol.id } })), "mentioning a non-reader stays inert text").toBe(0);

    // a viewer gets past VIEW on the same paths (so the 404s above are about access, not bad urls; pinning still needs MANAGE_MESSAGES)
    for (const [method, url, body] of paths.slice(0, 13)) expect((await call(method as never, url, insider.token, body)).statusCode, `insider ${method} ${url}`).not.toBe(404);
    expect((await call("GET", `/guilds/${guild.id}/messages/search?q=edited`, insider.token)).json().messages.map((m: any) => m.id)).toContain(msg.id);
    expect(await subscribe(await connect(insider), thread.id)).toEqual({ ok: true });
  });

  it("follows a parent overwrite change live: losing VIEW on the parent drops the thread's socket room at once", async () => {
    const { owner, insider, guild, role, secret, thread } = await setup();
    const s = await connect(insider);
    expect(await subscribe(s, thread.id)).toEqual({ ok: true });
    await post(owner, thread.id, "before");
    await until(() => s.got["message:new"]!.length === 1);
    // the role that opened #secret loses VIEW there: revalidate must also cover the thread's room
    await call("PUT", `/channels/${secret.id}/overwrites/${role.id}`, owner.token, { allow: 0, deny: 0 });
    await post(owner, thread.id, "after");
    await settle();
    expect(s.got["message:new"]!.map((m) => m.content)).toEqual(["before"]);
    expect(await subscribe(s, thread.id)).toEqual({ ok: false, error: "Not found" });
    expect((await call("GET", `/channels/${thread.id}/messages`, insider.token)).statusCode).toBe(404);
    // and back: VIEW on the parent is VIEW on the thread
    await call("PUT", `/channels/${secret.id}/overwrites/${role.id}`, owner.token, { allow: P.VIEW_CHANNEL, deny: 0 });
    expect((await call("GET", `/channels/${thread.id}/messages`, insider.token)).statusCode).toBe(200);
    expect(guild.id).toBeTruthy();
  });

  it("uses the parent's SEND_MESSAGES for posting and typing in the thread", async () => {
    const { owner, insider, carol, guild, general } = await setup();
    const starter = await post(owner, general.id, "g");
    const thread = (await startThread(owner, general.id, starter.id)).json();
    const watcher = await connect(owner);
    await subscribe(watcher, thread.id);
    const typer = await connect(carol);
    await call("PUT", `/channels/${general.id}/overwrites/${guild.id}`, owner.token, { allow: 0, deny: P.SEND_MESSAGES });
    expect((await send(carol, thread.id, "x")).statusCode).toBe(403);
    typer.emit("typing", { channelId: thread.id });
    await settle();
    expect(watcher.got.typing, "no typing relay without SEND").toEqual([]);
    expect((await send(insider, thread.id, "x")).statusCode, "nobody holds SEND through a role either").toBe(403);
    await call("DELETE", `/channels/${general.id}/overwrites/${guild.id}`, owner.token);
    expect((await send(carol, thread.id, "x")).statusCode).toBe(201);
  });
});

describe("rename, archive, delete", () => {
  it("lets the creator or a MANAGE_MESSAGES member change it, nobody else", async () => {
    const [owner, creator, other, mod] = await Promise.all(["owner", "creator", "other", "mod"].map(signUp));
    const { guild, general } = await guildWith(app, owner, creator, other, mod);
    await makeRole(guild.id, 1, P.MANAGE_MESSAGES, [mod.id]);
    const starter = await post(owner, general.id, "g");
    const thread = (await startThread(creator, general.id, starter.id)).json();
    const patch = (u: U, body: object) => call("PATCH", `/threads/${thread.id}`, u.token, body);
    expect((await patch(other, { name: "x" })).statusCode).toBe(403);
    expect((await call("DELETE", `/threads/${thread.id}`, other.token)).statusCode).toBe(403);
    expect((await patch(creator, { name: "renamed" })).json()).toMatchObject({ id: thread.id, name: "renamed", archived: false });
    expect((await patch(mod, { archived: true })).json()).toMatchObject({ archived: true });
    expect((await patch(creator, {})).statusCode, "nothing to update").toBe(400);
    expect((await patch(creator, { pinned: true })).statusCode, "strict").toBe(400);
    expect((await call("PATCH", `/threads/${general.id}`, owner.token, { name: "x" })).statusCode, "a plain channel is not a thread").toBe(404);
    expect((await call("DELETE", `/threads/${thread.id}`, mod.token)).statusCode).toBe(204);
    expect((await call("GET", `/channels/${thread.id}/messages`, creator.token)).statusCode).toBe(404);
  });

  it("refuses posts and uploads to an archived thread (409) until it is unarchived; reading stays open", async () => {
    const [owner, member] = await Promise.all(["owner", "member"].map(signUp));
    const { general } = await guildWith(app, owner, member);
    const starter = await post(owner, general.id, "g");
    const thread = (await startThread(member, general.id, starter.id)).json();
    await post(member, thread.id, "first");
    await call("PATCH", `/threads/${thread.id}`, member.token, { archived: true });
    expect((await send(owner, thread.id, "late")).json()).toEqual({ error: "Thread is archived" });
    expect((await send(owner, thread.id, "late")).statusCode).toBe(409);
    expect((await call("POST", "/attachments", member.token, { filename: "a.png", contentType: "image/png", size: 10, channelId: thread.id })).statusCode).toBe(409);
    expect((await history(owner, thread.id)).map((m) => m.content)).toEqual(["first"]);
    const archived = (await call("GET", `/channels/${general.id}/threads?archived=true`, owner.token)).json();
    expect(archived.threads.map((t: any) => t.id)).toEqual([thread.id]);
    expect((await call("GET", `/channels/${general.id}/threads`, owner.token)).json()).toEqual({ threads: [] });
    await call("PATCH", `/threads/${thread.id}`, member.token, { archived: false });
    expect((await send(owner, thread.id, "back")).statusCode).toBe(201);
  });

  it("lists active threads newest activity first, at most 50", async () => {
    const [owner] = await Promise.all(["owner"].map(signUp));
    const { general } = await guildWith(app, owner);
    const ids: string[] = [];
    for (const n of ["a", "b", "c"]) ids.push((await startThread(owner, general.id, (await post(owner, general.id, n)).id, n)).json().id);
    await post(owner, ids[0]!, "bump a");
    const list = (await call("GET", `/channels/${general.id}/threads`, owner.token)).json().threads;
    expect(list.map((t: any) => t.name)).toEqual(["a", "c", "b"]);
    expect(list[0]).toMatchObject({ messageCount: 1 });
    expect((await call("GET", `/channels/${general.id}/threads?archived=yes`, owner.token)).statusCode).toBe(400);
    const now = Date.now();
    await prisma.channel.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({ guildId: (list[0] as any).guildId, parentChannelId: general.id, type: "THREAD" as const, name: `t${i}`, position: 0, lastMessageAt: new Date(now - i * 1000) })),
    });
    expect((await call("GET", `/channels/${general.id}/threads`, owner.token)).json().threads).toHaveLength(50);
  });
});

describe("threads and the rest of the guild", () => {
  it("keeps thread messages out of the parent's history and threads out of the channel list, layout and channel routes", async () => {
    const [owner] = await Promise.all(["owner"].map(signUp));
    const { guild, general } = await guildWith(app, owner);
    const starter = await post(owner, general.id, "topic");
    // a thread may share a channel's name, and another thread's
    const thread = (await startThread(owner, general.id, starter.id, "general")).json();
    expect((await startThread(owner, general.id, (await post(owner, general.id, "t2")).id, "general")).statusCode).toBe(201);
    await post(owner, thread.id, "inside");
    expect((await history(owner, general.id)).map((m) => m.content), "parent history").toEqual(["topic", "t2"]);
    expect((await history(owner, thread.id)).map((m) => m.content)).toEqual(["inside"]);
    const data = (await call("GET", `/guilds/${guild.id}`, owner.token)).json();
    expect(data.channels.map((c: any) => c.id), "channel list").toEqual([general.id]);
    const layout = { categories: data.categories.map((c: any) => c.id), channels: [{ id: general.id, categoryId: data.categories[0].id }] };
    expect((await call("PUT", `/guilds/${guild.id}/layout`, owner.token, layout)).statusCode, "threads are not part of the layout set").toBe(200);
    expect((await call("PUT", `/guilds/${guild.id}/layout`, owner.token, { ...layout, channels: [...layout.channels, { id: thread.id, categoryId: null }] })).statusCode).toBe(400);
    expect((await call("DELETE", `/guilds/${guild.id}/channels/${general.id}`, owner.token)).statusCode, "threads do not count as a kept channel").toBe(409);
    expect((await call("PATCH", `/channels/${thread.id}`, owner.token, { topic: "x" })).statusCode).toBe(404);
    expect((await call("PUT", `/channels/${thread.id}/overwrites/${guild.id}`, owner.token, { allow: 0, deny: P.VIEW_CHANNEL })).statusCode).toBe(404);
    expect((await call("DELETE", `/guilds/${guild.id}/channels/${thread.id}`, owner.token)).statusCode).toBe(404);
    expect((await call("POST", `/channels/${thread.id}/voice/token`, owner.token)).statusCode).toBe(400);
  });

  it("tells the starter message about its thread (count and activity follow)", async () => {
    const [owner] = await Promise.all(["owner"].map(signUp));
    const { general } = await guildWith(app, owner);
    const starter = await post(owner, general.id, "topic");
    const other = await post(owner, general.id, "other");
    expect(other).toMatchObject({ thread: null });
    const thread = (await startThread(owner, general.id, starter.id, "plans")).json();
    const reply = await post(owner, thread.id, "r1");
    expect(reply).toMatchObject({ channelId: thread.id, thread: null });
    const [s1, s2] = await history(owner, general.id);
    const lastMessageAt = (await prisma.channel.findUniqueOrThrow({ where: { id: thread.id } })).lastMessageAt!.toISOString();
    expect(s1.thread, "the thread JSON").toEqual({ ...thread, messageCount: 1, lastMessageAt });
    expect(s2.thread).toBeNull();
    await call("DELETE", `/messages/${reply.id}`, owner.token);
    expect((await history(owner, general.id))[0].thread).toMatchObject({ messageCount: 0 });
  });

  it("deletes a parent's threads and their messages with it, and empties their socket rooms", async () => {
    const [owner, member] = await Promise.all(["owner", "member"].map(signUp));
    const { guild } = await guildWith(app, owner, member);
    const doomed = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "doomed", type: "TEXT" })).json();
    const thread = (await startThread(owner, doomed.id, (await post(owner, doomed.id, "s")).id)).json();
    await post(member, thread.id, "reply");
    const s = await connect(member);
    await subscribe(s, thread.id);
    expect((await call("DELETE", `/guilds/${guild.id}/channels/${doomed.id}`, owner.token)).statusCode).toBe(204);
    expect(await prisma.channel.count({ where: { id: thread.id } })).toBe(0);
    expect(await prisma.message.count({ where: { channelId: thread.id } })).toBe(0);
    // a message the server would still emit into the old room reaches nobody
    app.realtime.emit(thread.id, "message:new", { id: "ghost", channelId: thread.id });
    await settle();
    expect(s.got["message:new"]).toEqual([]);
  });

  it("deletes a guild's threads with the guild", async () => {
    const [owner] = await Promise.all(["owner"].map(signUp));
    const { guild, general } = await guildWith(app, owner);
    const thread = (await startThread(owner, general.id, (await post(owner, general.id, "s")).id)).json();
    await post(owner, thread.id, "r");
    await call("DELETE", `/guilds/${guild.id}`, owner.token);
    expect(await prisma.channel.count({ where: { id: thread.id } })).toBe(0);
  });
});

describe("thread events", () => {
  it("sends thread:created / updated / deleted only to members who can VIEW the parent", async () => {
    const { owner, insider, carol, outsider, guild, secret } = await setup();
    const [so, si, sc, sx] = await Promise.all([owner, insider, carol, outsider].map(connect));
    const starter = await post(insider, secret.id, "another");
    const thread = (await startThread(insider, secret.id, starter.id, "t")).json();
    await until(() => so.got["thread:created"]!.length === 1 && si.got["thread:created"]!.length === 1);
    expect(si.got["thread:created"]![0]).toEqual(thread);
    await call("PATCH", `/threads/${thread.id}`, insider.token, { name: "t2" });
    await until(() => si.got["thread:updated"]!.some((t) => t.name === "t2"));
    await call("DELETE", `/threads/${thread.id}`, insider.token);
    await until(() => so.got["thread:deleted"]!.length === 1);
    expect(so.got["thread:deleted"]![0]).toEqual({ id: thread.id, guildId: guild.id, parentChannelId: secret.id, starterMessageId: starter.id });
    await settle();
    for (const s of [sc, sx]) expect([s.got["thread:created"], s.got["thread:updated"], s.got["thread:deleted"]], "hidden parent / outsider").toEqual([[], [], []]);
  });

  it("pushes the new count to the parent channel's room when a thread gets a message", async () => {
    const [owner, member] = await Promise.all(["owner", "member"].map(signUp));
    const { general } = await guildWith(app, owner, member);
    const thread = (await startThread(owner, general.id, (await post(owner, general.id, "s")).id)).json();
    const watching = await connect(member);
    await subscribe(watching, general.id);
    const away = await connect(owner); // in no room but its own
    await post(owner, thread.id, "r1");
    await until(() => watching.got["thread:updated"]!.length === 1);
    expect(watching.got["thread:updated"]![0]).toMatchObject({ id: thread.id, messageCount: 1 });
    expect(watching.got["message:new"], "the thread's messages stay in the thread's room").toEqual([]);
    await settle();
    expect(away.got["thread:updated"]).toEqual([]);
  });

  it("counts unread messages and mentions per thread and says which channel it hangs off", async () => {
    const [owner, member] = await Promise.all(["owner", "member"].map(signUp));
    const { guild, general } = await guildWith(app, owner, member);
    const thread = (await startThread(owner, general.id, (await post(owner, general.id, "s")).id)).json();
    await unread(member);
    const s = await connect(member);
    await post(owner, thread.id, "plain");
    await post(owner, thread.id, `hey <@${member.id}>`);
    await until(() => s.got["mention:new"]!.length === 1);
    expect(s.got["mention:new"]![0]).toMatchObject({ guildId: guild.id, channelId: thread.id, parentChannelId: general.id });
    const counts = (await unread(member)).channels;
    expect(counts).toEqual([{ channelId: thread.id, guildId: guild.id, parentChannelId: general.id, unread: 2, mentions: 1 }]);
    await post(owner, general.id, "in the channel");
    const both = (await unread(member)).channels;
    expect(both.find((c: any) => c.channelId === general.id), "a plain channel has no parentChannelId").toEqual({ channelId: general.id, guildId: guild.id, unread: 1, mentions: 0 });
  });
});
