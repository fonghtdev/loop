import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, resetDb, signUp } from "../../test/helpers.js";
import { connect, listen, settle, until } from "../../test/sockets.js";
import { decodeToken, disconnectAll, eventually, expectInRoom, identities, joinAs, signedWebhook, testLivekit, webhookHeaders } from "../../test/voice.js";
import { dmRoom } from "./rooms.js";

const app = buildApp(env);
const call = caller(app);
const sockets: Socket[] = [];
let listening: Promise<number> | undefined; // an app can listen only once
const EVENTS = ["call:incoming", "call:declined", "call:ended"];

/** ann and ben are friends with a DM open and a socket each; cy is a stranger. */
async function fixture() {
  const [ann, ben, cy] = await Promise.all(["ann", "ben", "cy"].map((n) => signUp(app, n)));
  await befriend(app, ann, ben);
  const dm = (await call("POST", "/dms", ann.token, { userId: ben.id })).json() as { id: string };
  const port = await (listening ??= listen(app));
  const [annSock, benSock] = await Promise.all([ann, ben].map((u) => connect(port, u.token, EVENTS, sockets)));
  const start = (u: typeof ann, body?: object) => call("POST", `/dms/${dm.id}/call`, u.token, body);
  return { ann, ben, cy, dm, annSock: annSock!, benSock: benSock!, room: dmRoom(dm.id), start };
}

beforeEach(resetDb);
afterEach(async () => {
  await disconnectAll();
  sockets.splice(0).forEach((s) => s.close());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("starting and answering", () => {
  it("friends get a token for both microphone and camera; the other side rings once", async () => {
    const f = await fixture();
    const res = await f.start(f.ann, { video: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: env.livekit.url, room: f.room, expiresInSeconds: 600, canSpeak: true, canVideo: true });
    const claims = await decodeToken(res.json().token);
    expect(claims.video).toMatchObject({ room: f.room, canPublish: true, canPublishSources: ["microphone", "camera", "screen_share", "screen_share_audio"], canPublishData: false });
    await until(() => f.benSock.got["call:incoming"]!.length);
    expect(f.benSock.got["call:incoming"]).toEqual([{ dmChannelId: f.dm.id, from: { id: f.ann.id, username: "ann" }, video: true }]);
    await settle();
    expect(f.annSock.got["call:incoming"]).toEqual([]);
  });

  it("a bodyless start is an audio call", async () => {
    const f = await fixture();
    await f.start(f.ann);
    await until(() => f.benSock.got["call:incoming"]!.length);
    expect(f.benSock.got["call:incoming"]![0].video).toBe(false);
  });

  it("the caller already in the room is not rung again by a retry; the answer rings nobody; the room holds two", async () => {
    const f = await fixture();
    await joinAs((await f.start(f.ann)).json());
    await until(() => f.benSock.got["call:incoming"]!.length);
    await f.start(f.ann); // retry while alone in the room
    await joinAs((await f.start(f.ben)).json()); // the answer
    await expectInRoom(f.room, [f.ann.id, f.ben.id]);
    await settle();
    expect(f.benSock.got["call:incoming"]).toHaveLength(1);
    expect(f.annSock.got["call:incoming"]).toEqual([]);
    expect(await testLivekit.listRooms([f.room])).toEqual([{ name: f.room, maxParticipants: 2 }]);
  });
});

describe("who may call", () => {
  it("401, 404 for strangers and bad ids, 400 for a malformed body", async () => {
    const f = await fixture();
    expect((await call("POST", `/dms/${f.dm.id}/call`)).statusCode).toBe(401);
    expect((await f.start(f.cy)).statusCode).toBe(404);
    expect((await call("POST", "/dms/nope/call", f.ann.token)).statusCode).toBe(404);
    expect((await call("POST", "/dms/6f1d1f0e-0000-4000-8000-000000000000/call", f.ann.token)).statusCode).toBe(404);
    expect((await f.start(f.ann, { video: "yes" })).statusCode).toBe(400);
  });

  it("no longer friends, or blocked: 403 Not friends, exactly like sending a DM, and nobody rings", async () => {
    const f = await fixture();
    await call("DELETE", `/friends/${f.ben.id}`, f.ann.token);
    const send = await call("POST", `/dms/${f.dm.id}/messages`, f.ann.token, { content: "hi" });
    const res = await f.start(f.ann);
    expect([res.statusCode, res.json()]).toEqual([send.statusCode, send.json()]);
    expect(res.statusCode).toBe(403);
    await befriend(app, f.ben, f.ann);
    await call("PUT", `/blocks/${f.ann.id}`, f.ben.token);
    expect((await f.start(f.ann)).statusCode).toBe(403);
    expect((await f.start(f.ben)).statusCode).toBe(403);
    await settle();
    expect(f.benSock.got["call:incoming"]).toEqual([]);
  });
});

describe("declining", () => {
  it("tells the caller; participants only", async () => {
    const f = await fixture();
    await f.start(f.ann);
    expect((await call("POST", `/dms/${f.dm.id}/call/decline`, f.cy.token)).statusCode).toBe(404);
    expect((await call("POST", `/dms/${f.dm.id}/call/decline`)).statusCode).toBe(401);
    expect((await call("POST", `/dms/${f.dm.id}/call/decline`, f.ben.token)).statusCode).toBe(204);
    await until(() => f.annSock.got["call:declined"]!.length);
    expect(f.annSock.got["call:declined"]).toEqual([{ dmChannelId: f.dm.id, by: { id: f.ben.id } }]);
    expect(f.benSock.got["call:declined"]).toEqual([]);
  });
});

describe("ending", () => {
  it.each([
    ["blocking", (f: Awaited<ReturnType<typeof fixture>>) => call("PUT", `/blocks/${f.ann.id}`, f.ben.token)],
    ["unfriending", (f: Awaited<ReturnType<typeof fixture>>) => call("DELETE", `/friends/${f.ann.id}`, f.ben.token)],
  ])("%s mid-call closes the room and both sides get call:ended", async (_name, act) => {
    const f = await fixture();
    const annRoom = await joinAs((await f.start(f.ann)).json());
    await joinAs((await f.start(f.ben)).json());
    await expectInRoom(f.room, [f.ann.id, f.ben.id]);
    let disconnected = false;
    annRoom.on("disconnected", () => (disconnected = true));
    expect((await act(f)).statusCode).toBe(204);
    await until(() => f.annSock.got["call:ended"]!.length && f.benSock.got["call:ended"]!.length);
    expect(f.annSock.got["call:ended"]![0]).toEqual({ dmChannelId: f.dm.id });
    await eventually(async () => expect(await identities(f.room)).toEqual([]));
    await eventually(() => expect(disconnected).toBe(true));
  });

  it("blocking someone with no call running says nothing", async () => {
    const f = await fixture();
    await call("PUT", `/blocks/${f.ann.id}`, f.ben.token);
    await settle();
    expect(f.annSock.got["call:ended"]).toEqual([]);
  });

  it("LiveKit's room_finished and 'last participant left' webhooks end the call; a leaver with someone still in does not", async () => {
    const f = await fixture();
    const hook = async (event: object) => {
      const { body, authorization } = await signedWebhook(event);
      return app.inject({ method: "POST", url: "/livekit/webhook", payload: body, headers: webhookHeaders(authorization) });
    };
    await joinAs((await f.start(f.ben)).json());
    await hook({ event: "participant_left", room: { name: f.room }, participant: { identity: f.ann.id } });
    await settle();
    expect(f.annSock.got["call:ended"]).toEqual([]); // ben is still in
    await hook({ event: "room_finished", room: { name: f.room } });
    await until(() => f.annSock.got["call:ended"]!.length && f.benSock.got["call:ended"]!.length);
    expect(f.benSock.got["call:ended"]).toEqual([{ dmChannelId: f.dm.id }]);
    expect((await hook({ event: "room_finished", room: { name: dmRoom("6f1d1f0e-0000-4000-8000-000000000000") } })).statusCode).toBe(200);
  });
});
