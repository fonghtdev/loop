import { DEFAULT_EVERYONE_PERMISSIONS, MAX_VOICE_PARTICIPANTS, Permission as P } from "@loop/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, makeRole, resetDb, setEveryone, signUp } from "../../test/helpers.js";
import { connect, listen } from "../../test/sockets.js";
import { addVoiceChannel, decodeToken, disconnectAll, eventually, expectInRoom, joinAs, publishMic, publishScreen, RoomEvent, requestToken, testLivekit } from "../../test/voice.js";
import { voiceRoom } from "./rooms.js";
import type { Socket } from "socket.io-client";

const app = buildApp(env);
const call = caller(app);

/** owner + alice + bob in a guild with a voice channel (`voice`) next to the default text channel (`general`). */
async function fixture() {
  const [owner, alice, bob, outsider] = await Promise.all(["owner", "alice", "bob", "outsider"].map((n) => signUp(app, n)));
  const { guild, general } = await guildWith(app, owner, alice, bob);
  const voice = await addVoiceChannel(app, owner, guild.id);
  return { owner, alice, bob, outsider, guild, general, voice, room: voiceRoom(voice.id) };
}

const sockets: Socket[] = [];
beforeEach(resetDb);
afterEach(async () => {
  await disconnectAll();
  sockets.splice(0).forEach((s) => s.close());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("POST /channels/:id/voice/token authorization", () => {
  it("401 without a user, 404 for non-members and unknown or malformed ids", async () => {
    const f = await fixture();
    expect((await call("POST", `/channels/${f.voice.id}/voice/token`)).statusCode).toBe(401);
    expect((await requestToken(app, f.outsider, f.voice.id)).statusCode).toBe(404);
    expect((await requestToken(app, f.alice, "not-a-uuid")).statusCode).toBe(404);
    expect((await requestToken(app, f.alice, "6f1d1f0e-0000-4000-8000-000000000000")).statusCode).toBe(404);
  });

  it("404 for a channel the caller cannot see, even though it exists", async () => {
    const f = await fixture();
    await call("PUT", `/channels/${f.voice.id}/overwrites/${f.guild.id}`, f.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    expect((await requestToken(app, f.alice, f.voice.id)).statusCode).toBe(404);
    expect((await requestToken(app, f.owner, f.voice.id)).statusCode).toBe(200);
  });

  it("403 when the channel is visible but CONNECT is missing", async () => {
    const f = await fixture();
    await setEveryone(f.guild.id, DEFAULT_EVERYONE_PERMISSIONS & ~P.CONNECT);
    expect((await requestToken(app, f.alice, f.voice.id)).statusCode).toBe(403);
    await makeRole(f.guild.id, 1, P.CONNECT, [f.alice.id]);
    expect((await requestToken(app, f.alice, f.voice.id)).statusCode).toBe(200);
  });

  it("400 for a text channel", async () => {
    const f = await fixture();
    expect((await requestToken(app, f.alice, f.general.id)).statusCode).toBe(400);
  });
});

describe("token contents", () => {
  const grantsFor = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const res = await requestToken(app, f.alice, f.voice.id);
    expect(res.statusCode).toBe(200);
    return { res: res.json(), claims: await decodeToken(res.json().token) };
  };

  it("default member: identity, name, room, 10 minutes, microphone, camera and screen share, no data", async () => {
    const f = await fixture();
    const { res, claims } = await grantsFor(f);
    expect(res).toMatchObject({ url: env.livekit.url, room: f.room, expiresInSeconds: 600, canSpeak: true, canVideo: true, canStream: true });
    expect(claims).toMatchObject({ sub: f.alice.id, name: "alice" });
    expect(claims.exp! - claims.nbf!).toBe(600);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: f.room,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: true, // cosmetic deafen flag only (the client draws the headphones-off icon from it)
      canPublish: true,
      canPublishSources: ["microphone", "camera", "screen_share", "screen_share_audio"],
    });
  });

  it.each([
    ["SPEAK only", P.SPEAK, true, ["microphone"], true, false, false],
    ["VIDEO only", P.VIDEO, true, ["camera"], false, true, false],
    ["STREAM only", P.STREAM, true, ["screen_share", "screen_share_audio"], false, false, true],
    ["neither", 0, false, undefined, false, false, false],
  ])("%s", async (_name, bits, canPublish, sources, canSpeak, canVideo, canStream) => {
    const f = await fixture();
    await setEveryone(f.guild.id, P.VIEW_CHANNEL | P.CONNECT | bits);
    const { res, claims } = await grantsFor(f);
    expect(res).toMatchObject({ canSpeak, canVideo, canStream });
    expect(claims.video?.canPublish).toBe(canPublish);
    expect(claims.video?.canPublishSources ?? undefined).toEqual(sources ?? []);
    expect(claims.video?.canPublishData).toBe(false);
  });

  it("a channel overwrite that denies SPEAK takes the microphone away", async () => {
    const f = await fixture();
    await call("PUT", `/channels/${f.voice.id}/overwrites/${f.guild.id}`, f.owner.token, { allow: 0, deny: P.SPEAK });
    const { claims } = await grantsFor(f);
    expect(claims.video?.canPublishSources).toEqual(["camera", "screen_share", "screen_share_audio"]);
  });

  it("creates the room with 25 seats", async () => {
    const f = await fixture();
    await requestToken(app, f.alice, f.voice.id);
    expect(MAX_VOICE_PARTICIPANTS).toBe(25);
    expect(await testLivekit.listRooms([f.room])).toEqual([{ name: f.room, maxParticipants: 25 }]);
  });
});

describe("a full room", () => {
  it("409 for a newcomer, 200 for someone already seated (the room is pre-created with 2 seats; 25 real clients are too heavy)", async () => {
    const f = await fixture();
    await testLivekit.ensureRoom(f.room, 2, { emptyTimeout: 60, departureTimeout: 5 });
    const [a, b] = await Promise.all([f.owner, f.alice].map(async (u) => joinAs((await requestToken(app, u, f.voice.id)).json())));
    expect(a && b).toBeTruthy();
    await expectInRoom(f.room, [f.owner.id, f.alice.id]);
    const full = await requestToken(app, f.bob, f.voice.id);
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual({ error: "Channel is full" });
    expect((await requestToken(app, f.alice, f.voice.id)).statusCode).toBe(200);
  });
});

describe("same user, two tokens", () => {
  it("the second connection replaces the first: one seat, the first is disconnected", async () => {
    const f = await fixture();
    const first = await joinAs((await requestToken(app, f.alice, f.voice.id)).json());
    let reason: unknown;
    first.on(RoomEvent.Disconnected, (r) => (reason = r));
    await joinAs((await requestToken(app, f.alice, f.voice.id)).json());
    await eventually(() => expect(reason).toBeDefined());
    expect(await testLivekit.participants(f.room)).toHaveLength(1);
  });
});

describe("media", () => {
  it("two users see each other, GET lists both, SPEAK publishes and the other receives it", async () => {
    const f = await fixture();
    const alice = await joinAs((await requestToken(app, f.alice, f.voice.id)).json());
    const bob = await joinAs((await requestToken(app, f.bob, f.voice.id)).json());
    await eventually(() => expect(alice.remoteParticipants.has(f.bob.id)).toBe(true));
    expect(bob.remoteParticipants.has(f.alice.id)).toBe(true);

    const list = await call("GET", `/channels/${f.voice.id}/voice`, f.owner.token); // anyone who can see the channel
    expect(list.statusCode).toBe(200);
    expect(list.json().participants.map((p: { userId: string }) => p.userId).sort()).toEqual([f.alice.id, f.bob.id].sort());
    expect(list.json().participants[0]).toEqual({ userId: expect.any(String), username: expect.stringMatching(/alice|bob/), sharing: false, serverMute: false, serverDeafen: false });

    let received = "";
    bob.on(RoomEvent.TrackSubscribed, (_t, _p, participant) => (received = participant.identity));
    expect(await publishMic(alice)).toBe("published");
    await eventually(() => expect(received).toBe(f.alice.id));
  });

  it("without SPEAK the microphone cannot be published", async () => {
    const f = await fixture();
    await setEveryone(f.guild.id, P.VIEW_CHANNEL | P.CONNECT);
    const listener = await joinAs((await requestToken(app, f.alice, f.voice.id)).json());
    const other = await joinAs((await requestToken(app, f.bob, f.voice.id)).json());
    let heard = false;
    other.on(RoomEvent.TrackSubscribed, () => (heard = true));
    expect(await publishMic(listener)).toBe("refused");
    expect(heard).toBe(false);
    expect(listener.localParticipant!.trackPublications.size).toBe(0);
  });
});

describe("screen share", () => {
  it("STREAM alone (no SPEAK) publishes a screen, and the other side receives it", async () => {
    const f = await fixture();
    await setEveryone(f.guild.id, P.VIEW_CHANNEL | P.CONNECT | P.STREAM);
    const sharer = await joinAs((await requestToken(app, f.alice, f.voice.id)).json());
    const viewer = await joinAs((await requestToken(app, f.bob, f.voice.id)).json());
    let received = "";
    viewer.on(RoomEvent.TrackSubscribed, (_t, _p, participant) => (received = participant.identity));
    expect(await publishScreen(sharer)).toBe("published");
    await eventually(() => expect(received).toBe(f.alice.id));
  });

  it("without STREAM the screen cannot be published", async () => {
    const f = await fixture();
    await setEveryone(f.guild.id, DEFAULT_EVERYONE_PERMISSIONS & ~P.STREAM);
    const sharer = await joinAs((await requestToken(app, f.alice, f.voice.id)).json());
    expect(await publishScreen(sharer)).toBe("refused");
  });
});

describe("GET /channels/:id/voice", () => {
  it("needs only VIEW: 404 when hidden, 400 for a text channel, empty list when nobody is in", async () => {
    const f = await fixture();
    expect((await call("GET", `/channels/${f.voice.id}/voice`)).statusCode).toBe(401);
    expect((await call("GET", `/channels/${f.voice.id}/voice`, f.outsider.token)).statusCode).toBe(404);
    expect((await call("GET", `/channels/${f.general.id}/voice`, f.alice.token)).statusCode).toBe(400);
    await setEveryone(f.guild.id, P.VIEW_CHANNEL); // no CONNECT: may still look
    expect((await call("GET", `/channels/${f.voice.id}/voice`, f.alice.token)).json()).toEqual({ participants: [] });
    await call("PUT", `/channels/${f.voice.id}/overwrites/${f.guild.id}`, f.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    expect((await call("GET", `/channels/${f.voice.id}/voice`, f.alice.token)).statusCode).toBe(404);
  });
});

describe("realtime subscription", () => {
  it("channel:subscribe works for a voice channel and is refused when it is hidden", async () => {
    const f = await fixture();
    const port = await listen(app);
    const s = await connect(port, f.alice.token, [], sockets);
    const ack = (id: string) => new Promise((resolve) => s.emit("channel:subscribe", { channelId: id }, resolve));
    expect(await ack(f.voice.id)).toEqual({ ok: true });
    await call("PUT", `/channels/${f.voice.id}/overwrites/${f.guild.id}`, f.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    expect(await ack(f.voice.id)).toMatchObject({ ok: false });
  });
});
