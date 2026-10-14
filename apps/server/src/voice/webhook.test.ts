import { Permission as P } from "@loop/shared";
import { createHash } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, resetDb, signUp } from "../../test/helpers.js";
import { connect, listen, settle, until } from "../../test/sockets.js";
import { addVoiceChannel, disconnectAll, eventually, joinAs, publishMic, publishScreen, requestToken, signedWebhook, webhookHeaders } from "../../test/voice.js";
import { voiceRoom } from "./rooms.js";

const app = buildApp(env);
const call = caller(app);
const sockets: Socket[] = [];
let listening: Promise<number> | undefined; // an app can listen only once

const post = (body: string, authorization?: string, headers = webhookHeaders(authorization)) =>
  app.inject({ method: "POST", url: "/livekit/webhook", payload: body, headers });
const send = async (event: object) => {
  const { body, authorization } = await signedWebhook(event);
  return post(body, authorization);
};

async function fixture() {
  const [owner, alice, bob] = await Promise.all(["owner", "alice", "bob"].map((n) => signUp(app, n)));
  const { guild, general } = await guildWith(app, owner, alice, bob);
  const voice = await addVoiceChannel(app, owner, guild.id);
  const port = await (listening ??= listen(app));
  const sub = async (user: typeof alice, channelId = voice.id) => {
    const s = await connect(port, user.token, ["voice:update"], sockets);
    await new Promise((r) => s.emit("channel:subscribe", { channelId }, r));
    return s;
  };
  return { owner, alice, bob, guild, general, voice, room: voiceRoom(voice.id), sub, port };
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

describe("POST /livekit/webhook signature", () => {
  const event = { event: "participant_joined", room: { name: voiceRoom("6f1d1f0e-0000-4000-8000-000000000000") } };

  it("401 without an Authorization header", async () => {
    const { body } = await signedWebhook(event);
    expect((await post(body)).statusCode).toBe(401);
  });

  it("401 for a token signed with another secret", async () => {
    const body = JSON.stringify(event);
    const forged = new AccessToken(env.livekit.apiKey, "another-secret-another-secret-another-secret");
    forged.sha256 = createHash("sha256").update(body).digest("base64");
    expect((await post(body, await forged.toJwt())).statusCode).toBe(401);
  });

  it("401 when the signed body was swapped for another", async () => {
    const { authorization } = await signedWebhook(event);
    expect((await post(JSON.stringify({ ...event, event: "participant_left" }), authorization)).statusCode).toBe(401);
  });

  it("401 for garbage, and for a body that arrives parsed instead of raw", async () => {
    const { body, authorization } = await signedWebhook(event);
    expect((await post(body, "not-a-jwt")).statusCode).toBe(401);
    expect((await post(body, authorization, { "content-type": "application/json", authorization: authorization! })).statusCode).toBe(401);
    expect((await post("", authorization)).statusCode).toBe(401);
  });

  it("a valid signature is accepted and needs no user token", async () => {
    expect((await send(event)).statusCode).toBe(200);
  });
});

describe("voice:update", () => {
  it("goes to subscribers of the channel with the fresh list from LiveKit", async () => {
    const f = await fixture();
    const watcher = await f.sub(f.owner);
    const outsider = await connect(f.port, f.bob.token, ["voice:update"], sockets); // connected, not subscribed
    await joinAs((await requestToken(app, f.alice, f.voice.id)).json());
    const res = await send({ event: "participant_joined", room: { name: f.room }, participant: { identity: f.alice.id, name: "alice" } });
    expect(res.statusCode).toBe(200);
    await until(() => watcher.got["voice:update"]!.length);
    expect(watcher.got["voice:update"]![0]).toEqual({ channelId: f.voice.id, participants: [{ userId: f.alice.id, username: "alice", sharing: false }] });
    await settle();
    expect(outsider.got["voice:update"]).toEqual([]);
  });

  it("a screen-share track sets and clears `sharing` in the push and in the REST list; a mic track pushes nothing", async () => {
    const f = await fixture();
    const watcher = await f.sub(f.owner);
    const aliceRoom = await joinAs((await requestToken(app, f.alice, f.voice.id)).json());
    const track = (event: string, source: string) => send({ event, room: { name: f.room }, participant: { identity: f.alice.id }, track: { source } });
    const listed = async () => (await call("GET", `/channels/${f.voice.id}/voice`, f.owner.token)).json().participants[0].sharing;
    const last = () => watcher.got["voice:update"]!.at(-1).participants[0].sharing;

    expect(await publishMic(aliceRoom)).toBe("published");
    await track("track_published", "MICROPHONE");
    await settle();
    expect(watcher.got["voice:update"]).toEqual([]);

    expect(await publishScreen(aliceRoom)).toBe("published");
    await eventually(async () => expect(await listed()).toBe(true));
    await track("track_published", "SCREEN_SHARE");
    await until(() => watcher.got["voice:update"]!.length === 1);
    expect(last()).toBe(true);

    const pub = [...aliceRoom.localParticipant!.trackPublications.values()].find((p) => p.source === 3)!; // SOURCE_SCREENSHARE
    await aliceRoom.localParticipant!.unpublishTrack(pub.sid!);
    await eventually(async () => expect(await listed()).toBe(false));
    await track("track_unpublished", "SCREEN_SHARE");
    await until(() => watcher.got["voice:update"]!.length === 2);
    expect(last()).toBe(false);
  });

  it("participant_left and room_finished send the new, shorter list", async () => {
    const f = await fixture();
    const watcher = await f.sub(f.owner);
    await send({ event: "participant_left", room: { name: f.room }, participant: { identity: f.alice.id } });
    await send({ event: "room_finished", room: { name: f.room } });
    await until(() => watcher.got["voice:update"]!.length === 2);
    expect(watcher.got["voice:update"]).toEqual([
      { channelId: f.voice.id, participants: [] },
      { channelId: f.voice.id, participants: [] },
    ]);
  });

  it("does not reach someone who lost VIEW of the channel", async () => {
    const f = await fixture();
    const watcher = await f.sub(f.alice);
    await call("PUT", `/channels/${f.voice.id}/overwrites/${f.guild.id}`, f.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    await send({ event: "participant_joined", room: { name: f.room }, participant: { identity: f.bob.id } });
    await settle();
    expect(watcher.got["voice:update"]).toEqual([]);
  });

  it("unknown events, unknown rooms, text channels and foreign room names are acknowledged and ignored", async () => {
    const f = await fixture();
    const watcher = await f.sub(f.owner);
    const textWatcher = await f.sub(f.owner, f.general.id);
    for (const event of [
      { event: "track_published", room: { name: f.room } },
      { event: "participant_joined", room: { name: voiceRoom("6f1d1f0e-0000-4000-8000-000000000000") } },
      { event: "participant_joined", room: { name: voiceRoom(f.general.id) } },
      { event: "participant_joined", room: { name: "voice:not-a-uuid" } },
      { event: "participant_joined", room: { name: "something-else" } },
      { event: "participant_joined" },
      { event: "room_finished", room: { name: `dm:${f.voice.id}` } },
    ]) expect((await send(event)).statusCode, JSON.stringify(event)).toBe(200);
    await settle();
    expect(watcher.got["voice:update"]).toEqual([]);
    expect(textWatcher.got["voice:update"]).toEqual([]);
  });
});
