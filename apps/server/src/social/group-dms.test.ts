import { readFileSync } from "node:fs";
import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_GROUP_DM } from "@loop/shared";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, resetDb, signUp as signUpUser, uploadAttachment } from "../../test/helpers.js";
import { connect as connectTo, listen, settle, until, type Client } from "../../test/sockets.js";
import { disconnectAll, eventually, expectInRoom, identities, joinAs, signedWebhook, webhookHeaders } from "../../test/voice.js";
import { dmRoom } from "../voice/rooms.js";

const app = buildApp(env);
const call = caller(app);
type User = Awaited<ReturnType<typeof signUpUser>>;
const signUp = (name: string) => signUpUser(app, name);
const EVENTS = [
  "dm:new", "dm:updated", "dm:removed", "dm:message:new", "dm:message:update", "dm:message:delete", "dm:message:reaction", "dm:message:pin",
  "typing", "presence:update", "call:incoming", "call:ended",
];
let port: number;
const sockets: Socket[] = [];
const connect = (u: User) => connectTo(port, u.token, EVENTS, sockets);
const NOT_FOUND = { error: "Not found" };

beforeAll(async () => {
  port = await listen(app);
});
beforeEach(resetDb);
afterEach(async () => {
  await disconnectAll();
  sockets.splice(0).forEach((s) => s.disconnect());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/**
 * olly (owner) is friends with ann, ben and dee; ann is also friends with eve. ann and ben are NOT friends with
 * each other. zed is a stranger to everyone. The group is olly + ann + ben.
 */
async function fixture() {
  const [olly, ann, ben, dee, eve, zed] = await Promise.all(["olly", "ann", "ben", "dee", "eve", "zed"].map(signUp));
  for (const u of [ann, ben, dee]) await befriend(app, olly, u);
  await befriend(app, ann, eve);
  const res = await call("POST", "/dms/group", olly.token, { userIds: [ann.id, ben.id], name: "  Crew  " });
  expect(res.statusCode).toBe(201);
  const group = res.json() as { id: string };
  const url = (rest = "") => `/dms/${group.id}${rest}`;
  return { olly, ann, ben, dee, eve, zed, group, url };
}

const send = (u: User, url: string, content = "hello") => call("POST", `${url}/messages`, u.token, { content });

describe("POST /dms/group", () => {
  it("201 with every participant and the trimmed name; invitees get dm:new, the creator's devices dm:updated", async () => {
    const [olly, ann, ben] = await Promise.all(["olly", "ann", "ben"].map(signUp));
    await befriend(app, olly, ann);
    await befriend(app, olly, ben);
    const [so, sa, sb] = await Promise.all([connect(olly), connect(ann), connect(ben)]);
    const res = await call("POST", "/dms/group", olly.token, { userIds: [ann.id, ben.id], name: "  Crew  " });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ kind: "GROUP", name: "Crew", ownerId: olly.id, lastMessageAt: null });
    expect(body.participants.map((p: { id: string }) => p.id).sort()).toEqual([olly.id, ann.id, ben.id].sort());
    expect(body.participants.find((p: { id: string }) => p.id === olly.id)).toEqual({ id: olly.id, username: "olly", displayName: null, avatarHash: null, online: true, status: "online" });
    await until(() => sa.got["dm:new"]!.length && sb.got["dm:new"]!.length && so.got["dm:updated"]!.length);
    expect(sa.got["dm:new"]![0]).toMatchObject({ id: body.id, kind: "GROUP", ownerId: olly.id });
    expect(so.got["dm:new"]).toEqual([]);
    // GET /dms lists both kinds; pairs gained `kind` only
    await call("POST", "/dms", ann.token, { userId: olly.id });
    const list = (await call("GET", "/dms", ann.token)).json();
    expect(list.map((d: { kind: string }) => d.kind).sort()).toEqual(["GROUP", "PAIR"]);
    expect(list.find((d: { kind: string }) => d.kind === "PAIR")).toMatchObject({ kind: "PAIR", user: { id: olly.id } });
    expect((await call("GET", "/dms", ben.token)).json()).toHaveLength(1);
  });

  it("400 for too few, too many, duplicate, self, extra keys and a long name; 404 (one body) for unknown, non-friend, pending and blocked", async () => {
    const users = await Promise.all(["olly", "ann", "ben", "pen", "blo", "zed"].map(signUp));
    const [olly, ann, ben, pen, blo, zed] = users as [User, User, User, User, User, User];
    for (const u of [ann, ben, blo]) await befriend(app, olly, u);
    await call("POST", "/friends/requests", olly.token, { username: "pen" }); // still pending
    await call("PUT", `/blocks/${olly.id}`, blo.token); // blo blocks olly (ends the friendship)
    const create = (body: object) => call("POST", "/dms/group", olly.token, body);
    for (const body of [
      { userIds: [ann.id] },
      { userIds: Array.from({ length: MAX_GROUP_DM }, () => crypto.randomUUID()) },
      { userIds: [ann.id, ann.id] },
      { userIds: [ann.id, ben.id], extra: 1 },
      { userIds: [ann.id, ben.id], name: "x".repeat(101) },
      {},
    ]) expect((await create(body)).statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
    expect((await create({ userIds: [ann.id, olly.id] })).statusCode).toBe(400);
    for (const bad of [zed.id, pen.id, blo.id, crypto.randomUUID(), "nope"]) {
      const res = await create({ userIds: [ann.id, bad] });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect(await prisma.dmChannel.count({ where: { kind: "GROUP" } })).toBe(0);
  });

  it(`a group can hold ${MAX_GROUP_DM} people, then adding is 409`, async () => {
    const owner = await signUp("owner");
    const friends: User[] = [];
    for (let i = 0; i < MAX_GROUP_DM; i++) {
      friends.push(await signUp(`f${i}`));
      await befriend(app, owner, friends[i]!);
    }
    const res = await call("POST", "/dms/group", owner.token, { userIds: friends.slice(0, MAX_GROUP_DM - 1).map((f) => f.id) });
    expect(res.statusCode).toBe(201);
    expect(res.json().participants).toHaveLength(MAX_GROUP_DM);
    const add = await call("POST", `/dms/${res.json().id}/participants`, owner.token, { userId: friends[MAX_GROUP_DM - 1]!.id });
    expect(add.statusCode).toBe(409);
    expect(add.json()).toEqual({ error: "Group is full" });
  });
});

describe("participants", () => {
  it("any participant adds one of THEIR friends: dm:new to the newcomer, dm:updated to the rest; other cases", async () => {
    const f = await fixture();
    const [so, sb, se] = await Promise.all([connect(f.olly), connect(f.ben), connect(f.eve)]);
    const res = await call("POST", f.url("/participants"), f.ann.token, { userId: f.eve.id }); // eve is ann's friend, not olly's
    expect(res.statusCode).toBe(200);
    expect(res.json().participants.map((p: { id: string }) => p.id)).toContain(f.eve.id);
    await until(() => se.got["dm:new"]!.length && so.got["dm:updated"]!.length && sb.got["dm:updated"]!.length);
    expect(se.got["dm:updated"]).toEqual([]);
    // eve reads the history from before she joined and can write without being anyone else's friend
    expect((await call("GET", f.url("/messages"), f.eve.token)).statusCode).toBe(200);
    expect((await send(f.eve, f.url())).statusCode).toBe(201);

    expect((await call("POST", f.url("/participants"), f.ann.token, { userId: f.eve.id })).statusCode).toBe(409);
    expect((await call("POST", f.url("/participants"), f.ann.token, { userId: f.zed.id })).json()).toEqual(NOT_FOUND); // not ann's friend
    expect((await call("POST", f.url("/participants"), f.ann.token, { userId: f.dee.id })).statusCode).toBe(404); // olly's friend, not ann's
    expect((await call("POST", f.url("/participants"), f.ann.token, { userId: f.ann.id })).statusCode).toBe(409);
    expect((await call("POST", f.url("/participants"), f.ann.token, { userId: "nope" })).statusCode).toBe(404);
    expect((await call("POST", f.url("/participants"), f.ann.token, {})).statusCode).toBe(400);
    expect((await call("POST", f.url("/participants"), f.dee.token, { userId: f.olly.id })).json()).toEqual(NOT_FOUND); // outsider
    // blocked with the adder: same 404
    await call("PUT", `/blocks/${f.olly.id}`, f.dee.token);
    expect((await call("POST", f.url("/participants"), f.olly.token, { userId: f.dee.id })).statusCode).toBe(404);
  });

  it("pair DMs refuse the group routes with 400; outsiders and unknown ids get the same 404", async () => {
    const f = await fixture();
    const pair = (await call("POST", "/dms", f.olly.token, { userId: f.dee.id })).json() as { id: string };
    expect((await call("POST", `/dms/${pair.id}/participants`, f.olly.token, { userId: f.ann.id })).statusCode).toBe(400);
    expect((await call("DELETE", `/dms/${pair.id}/participants/me`, f.olly.token)).statusCode).toBe(400);
    expect((await call("PATCH", `/dms/${pair.id}`, f.olly.token, { name: "x" })).statusCode).toBe(400);
    for (const url of [f.url(), `/dms/${crypto.randomUUID()}`, "/dms/nope"]) {
      const res = await call("PATCH", url, f.zed.token, { name: "x" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect((await call("DELETE", `/dms/${pair.id}/participants/${f.dee.id}`, f.zed.token)).statusCode).toBe(404);
  });

  it("only the owner removes others (403), not themself (400), only participants (404); the removed one loses everything at once", async () => {
    const f = await fixture();
    const msg = (await send(f.ann, f.url(), "before")).json();
    await call("PUT", `/messages/${msg.id}/pin`, f.ann.token);
    const upload = await uploadAttachment(app, f.ann.token, { dmChannelId: f.group.id });
    const withFile = (await call("POST", f.url("/messages"), f.ann.token, { content: "file", attachmentIds: [upload.id] })).json();
    const benUpload = await uploadAttachment(app, f.ben.token, { dmChannelId: f.group.id }); // pending, completed, not attached

    expect((await call("DELETE", f.url(`/participants/${f.ann.id}`), f.ben.token)).statusCode).toBe(403);
    expect((await call("DELETE", f.url(`/participants/${f.olly.id}`), f.olly.token)).statusCode).toBe(400);
    expect((await call("DELETE", f.url(`/participants/${f.dee.id}`), f.olly.token)).statusCode).toBe(404);
    expect((await call("DELETE", f.url("/participants/nope"), f.olly.token)).statusCode).toBe(404);

    const [sb, sa] = await Promise.all([connect(f.ben), connect(f.ann)]);
    expect((await call("DELETE", f.url(`/participants/${f.ben.id}`), f.olly.token)).statusCode).toBe(204);
    await until(() => sb.got["dm:removed"]!.length && sa.got["dm:updated"]!.length);
    expect(sb.got["dm:removed"]).toEqual([{ dmChannelId: f.group.id }]);
    expect(sa.got["dm:updated"]![0].participants.map((p: { id: string }) => p.id)).not.toContain(f.ben.id);

    // every read and write path of the conversation is now the plain 404 for ben
    for (const [method, url, body] of [
      ["GET", f.url("/messages")],
      ["GET", f.url("/pins")],
      ["GET", f.url("/messages/search?q=before")],
      ["PUT", f.url("/read"), { seq: msg.seq }],
      ["POST", f.url("/messages"), { content: "still here?" }],
      ["PATCH", f.url(), { name: "mine" }],
      ["POST", f.url("/participants"), { userId: f.olly.id }],
      ["POST", f.url("/call")],
      ["POST", f.url("/call/decline")],
      ["GET", `/attachments/${withFile.attachments[0].id}`],
      ["PUT", `/messages/${msg.id}/reactions/${encodeURIComponent("👍")}`],
      ["DELETE", `/messages/${msg.id}/pin`],
      ["POST", "/attachments", { filename: "a.png", contentType: "image/png", size: 10, dmChannelId: f.group.id }],
    ] as const) {
      const res = await call(method, url, f.ben.token, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // his own message can no longer be sent with the upload made while he was in
    expect((await call("POST", f.url("/messages"), f.ben.token, { content: "x", attachmentIds: [benUpload.id] })).statusCode).toBe(404);
    expect((await call("GET", "/me/unread", f.ben.token)).json().dms).toEqual([]);
    expect((await call("GET", "/dms", f.ben.token)).json()).toEqual([]);

    // and no more events reach him
    await settle();
    sb.got["dm:message:new"] = [];
    await send(f.ann, f.url(), `<@${f.ben.id}> are you there`);
    sa.emit("typing", { dmChannelId: f.group.id });
    await until(() => sa.got["dm:message:new"]!.length);
    await settle();
    expect(sb.got["dm:message:new"]).toEqual([]);
    expect(sb.got["typing"]).toEqual([]);
    const last = (await call("GET", f.url("/messages"), f.ann.token)).json().messages.at(-1);
    expect(last.mentions).toEqual([]); // not a participant: not mentionable
  });

  it("leaving: 204 and dm:removed; the owner hands over to the longest-standing; the last one out deletes the group", async () => {
    const f = await fixture();
    await call("POST", f.url("/participants"), f.ann.token, { userId: f.eve.id }); // eve joins last
    await send(f.ann, f.url());
    const so = await connect(f.olly);
    expect((await call("DELETE", f.url("/participants/me"), f.olly.token)).statusCode).toBe(204);
    await until(() => so.got["dm:removed"]!.length);
    expect((await call("DELETE", f.url("/participants/me"), f.olly.token)).statusCode).toBe(404); // gone already
    const after = (await call("GET", "/dms", f.ann.token)).json()[0];
    // the longest-standing of ann and ben (eve came later), by the same order the server uses
    const heir = (await prisma.dmParticipant.findFirstOrThrow({ where: { dmChannelId: f.group.id, userId: { in: [f.ann.id, f.ben.id] } }, orderBy: [{ joinedAt: "asc" }, { userId: "asc" }] })).userId;
    expect(after.ownerId).toBe(heir);
    // the new owner may remove, the old one is out
    const other = heir === f.ann.id ? f.ben : f.ann;
    expect((await call("DELETE", f.url(`/participants/${f.eve.id}`), other.token)).statusCode).toBe(403);
    expect((await call("DELETE", f.url(`/participants/${f.eve.id}`), heir === f.ann.id ? f.ann.token : f.ben.token)).statusCode).toBe(204);
    // a lone participant keeps the group until they leave too
    expect((await call("DELETE", f.url("/participants/me"), other.token)).statusCode).toBe(204);
    const lastOne = heir === f.ann.id ? f.ann : f.ben;
    expect((await call("GET", f.url("/messages"), lastOne.token)).statusCode).toBe(200);
    expect((await call("DELETE", f.url("/participants/me"), lastOne.token)).statusCode).toBe(204);
    expect(await prisma.dmChannel.count({ where: { id: f.group.id } })).toBe(0);
    expect(await prisma.message.count({ where: { dmChannelId: f.group.id } })).toBe(0);
  });

  it("concurrent adds never exceed the cap", async () => {
    const owner = await signUp("owner");
    const friends: User[] = [];
    for (let i = 0; i < MAX_GROUP_DM + 2; i++) {
      friends.push(await signUp(`f${i}`));
      await befriend(app, owner, friends[i]!);
    }
    const dm = (await call("POST", "/dms/group", owner.token, { userIds: friends.slice(0, 2).map((x) => x.id) })).json();
    const results = await Promise.all(friends.slice(2).map((x) => call("POST", `/dms/${dm.id}/participants`, owner.token, { userId: x.id })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(MAX_GROUP_DM - 3);
    expect(await prisma.dmParticipant.count({ where: { dmChannelId: dm.id } })).toBe(MAX_GROUP_DM);
  });

  it("PATCH renames for any participant (dm:updated to all), null or empty clears, too long is 400", async () => {
    const f = await fixture();
    const [so, sb] = await Promise.all([connect(f.olly), connect(f.ben)]);
    const res = await call("PATCH", f.url(), f.ben.token, { name: " Night owls " });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Night owls");
    await until(() => so.got["dm:updated"]!.length && sb.got["dm:updated"]!.length);
    expect(so.got["dm:updated"]![0].name).toBe("Night owls");
    expect((await call("PATCH", f.url(), f.ann.token, { name: "" })).json().name).toBeNull();
    expect((await call("PATCH", f.url(), f.ann.token, { name: "x" })).json().name).toBe("x");
    expect((await call("PATCH", f.url(), f.ann.token, { name: null })).json().name).toBeNull();
    for (const body of [{ name: "x".repeat(101) }, { name: "a‮b" }, {}, { name: "ok", iconHash: "x" }]) {
      expect((await call("PATCH", f.url(), f.ann.token, body)).statusCode).toBe(400);
    }
  });
});

describe("messages in a group", () => {
  it("reach every participant's sockets (new, reaction, pin, update, delete, typing) and no outsider; members need not be friends", async () => {
    const f = await fixture();
    const [so, sa, sb, sd] = (await Promise.all([connect(f.olly), connect(f.ann), connect(f.ben), connect(f.dee)])) as Client[];
    await settle();
    const res = await send(f.ben, f.url(), `hi <@${f.ann.id}> <@${f.dee.id}>`); // ben and ann are not friends
    expect(res.statusCode).toBe(201);
    const m = res.json();
    expect(m.mentions).toEqual([f.ann.id]); // dee is not in the group
    expect(m.mentionEveryone).toBe(false);
    await until(() => so.got["dm:message:new"]!.length && sa.got["dm:message:new"]!.length && sb.got["dm:message:new"]!.length);
    expect((await call("PUT", `/messages/${m.id}/reactions/${encodeURIComponent("🔥")}`, f.ann.token)).statusCode).toBe(204);
    expect((await call("PUT", `/messages/${m.id}/pin`, f.olly.token)).statusCode).toBe(204);
    expect((await call("PATCH", `/messages/${m.id}`, f.ben.token, { content: "edited" })).statusCode).toBe(200);
    expect((await call("PATCH", `/messages/${m.id}`, f.ann.token, { content: "not mine" })).statusCode).toBe(403);
    sa.emit("typing", { dmChannelId: f.group.id });
    await until(() => so.got["typing"]!.length && sb.got["typing"]!.length);
    expect(sa.got["typing"]).toEqual([]);
    for (const s of [so, sa, sb]) {
      await until(() => s.got["dm:message:reaction"]!.length && s.got["dm:message:pin"]!.length && s.got["dm:message:update"]!.length);
    }
    expect((await call("DELETE", `/messages/${m.id}`, f.ben.token)).statusCode).toBe(204);
    await until(() => so.got["dm:message:delete"]!.length && sa.got["dm:message:delete"]!.length);
    await settle();
    for (const event of EVENTS.filter((e) => e.startsWith("dm:message") || e === "typing")) expect(sd.got[event], event).toEqual([]);
  });

  it("history, pins, search, unread and attachments work for members; outsiders get 404", async () => {
    const f = await fixture();
    const first = (await send(f.ann, f.url(), "hello crew")).json();
    await call("PUT", `/messages/${first.id}/pin`, f.ben.token);
    const up = await uploadAttachment(app, f.ben.token, { dmChannelId: f.group.id });
    expect(up.complete.statusCode).toBe(200);
    const withFile = (await call("POST", f.url("/messages"), f.ben.token, { content: "pic", attachmentIds: [up.id] })).json();
    expect(withFile.attachments).toHaveLength(1);
    expect((await call("GET", `/attachments/${up.id}`, f.ann.token)).statusCode).toBe(200);
    expect((await call("GET", f.url("/messages"), f.olly.token)).json().messages.map((m: { id: string }) => m.id)).toEqual([first.id, withFile.id]);
    expect((await call("GET", f.url("/pins"), f.olly.token)).json().messages.map((m: { id: string }) => m.id)).toEqual([first.id]);
    expect((await call("GET", f.url("/messages/search?q=crew"), f.ben.token)).json().messages.map((m: { id: string }) => m.id)).toEqual([first.id]);
    // unread: the seed marks everything read; a later message counts for the others, not the author
    await call("GET", "/me/unread", f.olly.token);
    await send(f.ann, f.url(), `ping <@${f.olly.id}>`);
    expect((await call("GET", "/me/unread", f.olly.token)).json().dms).toEqual([{ dmChannelId: f.group.id, unread: 1, mentions: 1 }]);
    for (const url of [f.url("/messages"), f.url("/pins"), f.url("/messages/search?q=crew"), `/attachments/${up.id}`]) {
      expect((await call("GET", url, f.dee.token)).statusCode, url).toBe(404);
    }
    expect((await uploadAttachment(app, f.dee.token, { dmChannelId: f.group.id })).create.statusCode).toBe(404);
  });

  it("group co-members who are not friends see each other's presence", async () => {
    const f = await fixture();
    const sa = await connect(f.ann);
    await settle();
    sa.got["presence:update"] = [];
    const sb = await connect(f.ben);
    await until(() => sa.got["presence:update"]!.some((e: { userId: string }) => e.userId === f.ben.id));
    sb.disconnect();
    const list = (await call("GET", "/dms", f.ann.token)).json()[0];
    expect(list.participants.find((p: { id: string }) => p.id === f.ann.id)).toMatchObject({ status: "online" });
  });
});

describe("calls in a group", () => {
  it("the first one in rings every other participant; the room holds the group; a removed member is put out of the call", async () => {
    const f = await fixture();
    const [so, sa, sb, sd] = await Promise.all([connect(f.olly), connect(f.ann), connect(f.ben), connect(f.dee)]);
    const start = await call("POST", f.url("/call"), f.olly.token, { video: false });
    expect(start.statusCode).toBe(200);
    expect(start.json().room).toBe(dmRoom(f.group.id));
    await joinAs(start.json());
    await until(() => sa.got["call:incoming"]!.length && sb.got["call:incoming"]!.length);
    expect(sa.got["call:incoming"]![0]).toMatchObject({ dmChannelId: f.group.id, from: { id: f.olly.id }, video: false });
    const benJoin = (await call("POST", f.url("/call"), f.ben.token)).json();
    await joinAs(benJoin);
    await joinAs((await call("POST", f.url("/call"), f.ann.token)).json()); // a third seat: more than a pair room
    await expectInRoom(dmRoom(f.group.id), [f.olly.id, f.ann.id, f.ben.id]);
    await settle();
    expect(so.got["call:incoming"]).toEqual([]);
    expect(sd.got["call:incoming"]).toEqual([]);
    expect(sa.got["call:incoming"]).toHaveLength(1); // answers ring nobody

    await call("DELETE", f.url(`/participants/${f.ben.id}`), f.olly.token);
    await expectInRoom(dmRoom(f.group.id), [f.olly.id, f.ann.id]);
    // his token (still valid for minutes) gets him back in, and the join webhook puts him out again
    await joinAs(benJoin);
    await eventually(async () => expect(await identities(dmRoom(f.group.id))).toContain(f.ben.id));
    const { body, authorization } = await signedWebhook({ event: "participant_joined", room: { name: dmRoom(f.group.id) }, participant: { identity: f.ben.id } });
    expect((await app.inject({ method: "POST", url: "/livekit/webhook", payload: body, headers: webhookHeaders(authorization) })).statusCode).toBe(200);
    await expectInRoom(dmRoom(f.group.id), [f.olly.id, f.ann.id]);
  });

  it("call:ended goes to every participant when the room finishes", async () => {
    const f = await fixture();
    const [so, sa, sb, sd] = await Promise.all([connect(f.olly), connect(f.ann), connect(f.ben), connect(f.dee)]);
    const { body, authorization } = await signedWebhook({ event: "room_finished", room: { name: dmRoom(f.group.id) } });
    await app.inject({ method: "POST", url: "/livekit/webhook", payload: body, headers: webhookHeaders(authorization) });
    await until(() => so.got["call:ended"]!.length && sa.got["call:ended"]!.length && sb.got["call:ended"]!.length);
    await settle();
    expect(sd.got["call:ended"]).toEqual([]);
  });
});

describe("migration", () => {
  it("a pair inserted the old way (pair columns only) gets its two participants from the trigger", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const [low, high] = [a.id, b.id].sort();
    await prisma.$executeRaw`INSERT INTO "DmChannel" (id, "userLowId", "userHighId") VALUES (gen_random_uuid(), ${low}::uuid, ${high}::uuid)`;
    const dm = await prisma.dmChannel.findFirstOrThrow({ include: { participants: true } });
    expect(dm.kind).toBe("PAIR");
    expect(dm.participants.map((p) => p.userId).sort()).toEqual([low, high]);
    expect((await send(a, `/dms/${dm.id}`)).statusCode).toBe(201);
  });

  it("the backfill gives every existing pair its two participants, once", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await befriend(app, a, b);
    await befriend(app, a, c);
    for (const u of [b, c]) await call("POST", "/dms", a.token, { userId: u.id });
    await prisma.dmParticipant.deleteMany({}); // as before the migration
    const sql = readFileSync(new URL("../../prisma/migrations/20261018000000_group_dms/migration.sql", import.meta.url), "utf8");
    const backfill = sql.slice(sql.indexOf('INSERT INTO "DmParticipant"'), sql.indexOf("ON CONFLICT DO NOTHING;") + "ON CONFLICT DO NOTHING".length);
    await prisma.$executeRawUnsafe(backfill);
    await prisma.$executeRawUnsafe(backfill); // idempotent
    expect(await prisma.dmParticipant.count()).toBe(4);
    for (const dm of await prisma.dmChannel.findMany({ include: { participants: true } })) {
      expect(dm.participants.map((p) => p.userId).sort()).toEqual([dm.userLowId, dm.userHighId].sort());
    }
  });

  it("CHECKs keep the two shapes apart", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    const [low, high] = [a.id, b.id].sort();
    await expect(prisma.$executeRaw`INSERT INTO "DmChannel" (id, kind, "userLowId", "userHighId") VALUES (gen_random_uuid(), 'GROUP', ${low}::uuid, ${high}::uuid)`).rejects.toThrow(/kind_shape/);
    await expect(prisma.$executeRaw`INSERT INTO "DmChannel" (id, "userLowId", "userHighId", name) VALUES (gen_random_uuid(), ${low}::uuid, ${high}::uuid, 'x')`).rejects.toThrow(/kind_shape/);
    await expect(prisma.$executeRaw`INSERT INTO "DmChannel" (id) VALUES (gen_random_uuid())`).rejects.toThrow(/kind_shape/);
    await expect(prisma.$executeRaw`INSERT INTO "DmChannel" (id, kind, name) VALUES (gen_random_uuid(), 'GROUP', ${"x".repeat(101)})`).rejects.toThrow(/name_check/);
  });
});
