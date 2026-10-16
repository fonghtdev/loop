import { DEFAULT_EVERYONE_PERMISSIONS, Permission as P } from "@loop/shared";
import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, makeRole, resetDb, setEveryone, signUp } from "../../test/helpers.js";
import { connect, listen, settle, until } from "../../test/sockets.js";
import { addVoiceChannel, countFrames, decodeToken, disconnectAll, eventually, expectInRoom, joinAs, publishMic, publishTone, requestToken, RoomEvent, testLivekit } from "../../test/voice.js";
import { voiceRoom } from "./rooms.js";

/** Server mute / deafen of others: who may, on whom, and that LiveKit, the token and rejoins all honour it. Real LiveKit. */
const app = buildApp(env);
const call = caller(app);
const sockets: Socket[] = [];
let port: number;

/**
 * mod (top 5, MUTE + DEAFEN); peer (top 6); target (plain); listener (plain). target and listener sit in `a`
 * (media-connected); `b` is a second voice channel; `text` = #general.
 */
async function fixture(modBits = P.MUTE_MEMBERS | P.DEAFEN_MEMBERS) {
  const [owner, mod, peer, target, listener, outsider] = await Promise.all(["owner", "mod", "peer", "target", "listener", "outsider"].map((n) => signUp(app, n)));
  const { guild, general } = await guildWith(app, owner, mod, peer, target, listener);
  await makeRole(guild.id, 5, modBits, [mod.id]);
  await makeRole(guild.id, 6, 0, [peer.id]);
  const a = await addVoiceChannel(app, owner, guild.id, "a");
  const b = await addVoiceChannel(app, owner, guild.id, "b");
  const rooms = {
    target: await joinAs((await requestToken(app, target, a.id)).json()),
    listener: await joinAs((await requestToken(app, listener, a.id)).json()),
  };
  await expectInRoom(voiceRoom(a.id), [target.id, listener.id]);
  return { owner, mod, peer, target, listener, outsider, guild, general, a, b, rooms };
}
type F = Awaited<ReturnType<typeof fixture>>;
const setState = (who: { token: string }, channel: { id: string }, userId: string, body: object) =>
  call("PUT", `/channels/${channel.id}/voice/members/${userId}/state`, who.token, body);
const seatOf = async (f: F, userId: string, channel = f.a) => (await testLivekit.participants(voiceRoom(channel.id))).find((s) => s.userId === userId);
const modState = (f: F, userId: string) => prisma.voiceModState.findUnique({ where: { guildId_userId: { guildId: f.guild.id, userId } } });

beforeAll(async () => {
  port = await listen(app);
});
beforeEach(resetDb);
afterEach(async () => {
  await disconnectAll();
  sockets.splice(0).forEach((s) => s.close());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("who may server-mute / deafen whom", () => {
  it("needs the matching bit in that channel, a target strictly below you (or ownership), never yourself", async () => {
    const f = await fixture(P.MUTE_MEMBERS);
    const peerRoom = await joinAs((await requestToken(app, f.peer, f.a.id)).json());
    const ownerRoom = await joinAs((await requestToken(app, f.owner, f.a.id)).json());
    await expectInRoom(voiceRoom(f.a.id), [f.target.id, f.listener.id, f.peer.id, f.owner.id]);
    expect((await setState(f.listener, f.a, f.target.id, { mute: true })).statusCode, "no bit").toBe(403);
    expect((await setState(f.mod, f.a, f.target.id, { deafen: true })).statusCode, "MUTE only, asks deafen").toBe(403);
    expect((await setState(f.mod, f.a, f.target.id, { mute: true, deafen: true })).statusCode, "one of two bits").toBe(403);
    expect((await setState(f.mod, f.a, f.peer.id, { mute: true })).statusCode, "above the mod").toBe(403);
    expect((await setState(f.mod, f.a, f.owner.id, { mute: true })).statusCode, "the owner").toBe(403);
    expect((await setState(f.mod, f.a, f.mod.id, { mute: true })).statusCode, "yourself").toBe(400);
    expect(await prisma.voiceModState.count()).toBe(0);
    expect((await setState(f.mod, f.a, f.target.id, { mute: true })).statusCode).toBe(204);
    expect((await setState(f.owner, f.a, f.peer.id, { mute: true, deafen: true })).statusCode, "the owner outranks everyone").toBe(204);
    void peerRoom;
    void ownerRoom;
  });

  it("the target must sit in THIS channel's room; hidden / text channels, strangers and bad bodies are refused", async () => {
    const f = await fixture();
    expect((await setState(f.mod, f.b, f.target.id, { mute: true })).statusCode, "in another channel").toBe(409);
    expect((await setState(f.mod, f.a, f.peer.id, { mute: true })).statusCode, "above, and not in voice: rank first").toBe(403);
    await makeRole(f.guild.id, 1, 0, [f.peer.id]); // (peer stays above)
    const low = await signUp(app, "low");
    const { code } = (await call("POST", `/guilds/${f.guild.id}/invites`, f.owner.token, {})).json();
    await call("POST", `/invites/${code}/join`, low.token);
    expect((await setState(f.mod, f.a, low.id, { mute: true })).statusCode, "not in voice").toBe(409);
    expect((await setState(f.mod, f.a, f.outsider.id, { mute: true })).statusCode, "not a member").toBe(404);
    expect((await setState(f.mod, f.a, "nope", { mute: true })).statusCode).toBe(404);
    expect((await setState(f.outsider, f.a, f.target.id, { mute: true })).statusCode, "outsider caller").toBe(404);
    expect((await setState(f.mod, f.general, f.target.id, { mute: true })).statusCode, "text channel").toBe(400);
    for (const body of [{}, { mute: "yes" }, { mute: true, extra: 1 }]) expect((await setState(f.mod, f.a, f.target.id, body)).statusCode, JSON.stringify(body)).toBe(400);
    await call("PUT", `/channels/${f.a.id}/overwrites/${f.guild.id}`, f.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    expect((await setState(f.mod, f.a, f.target.id, { mute: true })).statusCode, "hidden channel").toBe(404);
  });

  it("the bits can be given in one voice channel only (channel overwrite)", async () => {
    const f = await fixture(0);
    const role = await prisma.role.findFirstOrThrow({ where: { guildId: f.guild.id, position: 5 } });
    await call("PUT", `/channels/${f.b.id}/overwrites/${role.id}`, f.owner.token, { allow: P.MUTE_MEMBERS, deny: 0 });
    expect((await setState(f.mod, f.a, f.target.id, { mute: true })).statusCode).toBe(403);
    const inB = await joinAs((await requestToken(app, f.target, f.b.id)).json()); // the same identity moves to b
    await expectInRoom(voiceRoom(f.b.id), [f.target.id]);
    expect((await setState(f.mod, f.b, f.target.id, { mute: true })).statusCode).toBe(204);
    void inB;
  });
});

describe("the state reaches LiveKit, the token and the clients", () => {
  it("mute takes the microphone at once and gives it back on unmute", async () => {
    const f = await fixture();
    let heard = 0;
    let dropped = 0;
    f.rooms.listener.on(RoomEvent.TrackSubscribed, () => heard++);
    f.rooms.listener.on(RoomEvent.TrackUnsubscribed, () => dropped++);
    expect(await publishMic(f.rooms.target)).toBe("published");
    await eventually(() => expect(heard).toBe(1));
    expect((await setState(f.mod, f.a, f.target.id, { mute: true })).statusCode).toBe(204);
    await eventually(() => expect(dropped).toBe(1));
    expect(await seatOf(f, f.target.id)).toMatchObject({ speak: false, video: true, stream: true, listen: true });
    expect((await setState(f.mod, f.a, f.target.id, { mute: false })).statusCode).toBe(204);
    await eventually(async () => expect((await seatOf(f, f.target.id))?.speak).toBe(true));
    expect(await modState(f, f.target.id)).toBeNull(); // nothing left: no row
    expect(await publishMic(f.rooms.target)).toBe("published");
  });

  it("deafen stops the target hearing anyone (and talking), undeafen restores both", { timeout: 20000 }, async () => {
    const f = await fixture();
    const received = countFrames(f.rooms.target);
    const tone = await publishTone(f.rooms.listener);
    try {
      await eventually(() => expect(received.frames).toBeGreaterThan(50)); // audio really flows
      expect((await setState(f.mod, f.a, f.target.id, { deafen: true })).statusCode).toBe(204);
      expect(await seatOf(f, f.target.id)).toMatchObject({ listen: false, speak: false });
      await new Promise((r) => setTimeout(r, 700)); // LiveKit stops forwarding within a few hundred ms
      received.frames = 0;
      await new Promise((r) => setTimeout(r, 1500));
      expect(received.frames, "frames while deafened").toBeLessThan(5);
      expect((await setState(f.mod, f.a, f.target.id, { deafen: false })).statusCode).toBe(204);
      await eventually(async () => expect(await seatOf(f, f.target.id)).toMatchObject({ listen: true, speak: true }));
      await eventually(() => expect(received.frames).toBeGreaterThan(50)); // hears again without rejoining
    } finally {
      tone.stop();
    }
  });

  it("a rejoin cannot shed it: the token says so and grants no microphone / no subscribe; leaving voice keeps it", async () => {
    const f = await fixture();
    await setState(f.mod, f.a, f.target.id, { mute: true });
    await f.rooms.target.disconnect();
    await expectInRoom(voiceRoom(f.a.id), [f.listener.id]);
    let res = (await requestToken(app, f.target, f.b.id)).json();
    expect(res).toMatchObject({ canSpeak: false, canVideo: true, serverMuted: true, serverDeafened: false });
    let claims = (await decodeToken(res.token)).video!;
    expect(claims.canPublishSources).toEqual(["camera", "screen_share", "screen_share_audio"]);
    expect(claims.canSubscribe).toBe(true);
    const back = await joinAs(res);
    await expectInRoom(voiceRoom(f.b.id), [f.target.id]);
    expect(await publishMic(back)).toBe("refused");
    expect(await seatOf(f, f.target.id, f.b)).toMatchObject({ speak: false });
    // deafened: no subscribe, no microphone
    await setState(f.mod, f.b, f.target.id, { deafen: true });
    res = (await requestToken(app, f.target, f.a.id)).json();
    claims = (await decodeToken(res.token)).video!;
    expect(res).toMatchObject({ canSpeak: false, serverMuted: true, serverDeafened: true });
    expect(claims.canSubscribe).toBe(false);
    // even a fresh SPEAK grant (role edit -> enforce) never lifts it: rights are bits MINUS the state
    await call("PATCH", `/guilds/${f.guild.id}/roles/${f.guild.id}`, f.owner.token, { permissions: DEFAULT_EVERYONE_PERMISSIONS });
    await settle();
    expect(await seatOf(f, f.target.id, f.b)).toMatchObject({ speak: false, listen: false });
    await setEveryone(f.guild.id, DEFAULT_EVERYONE_PERMISSIONS);
    await app.voice.reconcile();
    expect(await seatOf(f, f.target.id, f.b)).toMatchObject({ speak: false, listen: false });
  });

  it("goes with the membership: a kick clears it, so the rejoined member speaks again", async () => {
    const f = await fixture();
    await setState(f.mod, f.a, f.target.id, { mute: true, deafen: true });
    expect(await modState(f, f.target.id)).toMatchObject({ serverMute: true, serverDeafen: true, setById: f.mod.id });
    await call("DELETE", `/guilds/${f.guild.id}/members/${f.target.id}`, f.owner.token);
    expect(await modState(f, f.target.id)).toBeNull();
    const { code } = (await call("POST", `/guilds/${f.guild.id}/invites`, f.owner.token, {})).json();
    await call("POST", `/invites/${code}/join`, f.target.token);
    expect((await requestToken(app, f.target, f.a.id)).json()).toMatchObject({ canSpeak: true, serverMuted: false, serverDeafened: false });
  });

  it("voice:moderated reaches only the target; voice:update and GET .../voice carry the server flags", async () => {
    const f = await fixture();
    const [target, mod, listener] = await Promise.all([f.target, f.mod, f.listener].map((u) => connect(port, u.token, ["voice:moderated", "voice:update"], sockets)));
    await new Promise<void>((r) => listener!.emit("channel:subscribe", { channelId: f.a.id }, () => r()));
    await setState(f.mod, f.a, f.target.id, { mute: true });
    await until(() => target!.got["voice:moderated"]!.length === 1);
    expect(target!.got["voice:moderated"]![0]).toEqual({ channelId: f.a.id, serverMute: true, serverDeafen: false, by: { id: f.mod.id, username: "mod" } });
    await until(() => listener!.got["voice:update"]!.some((e) => e.participants.some((p: { serverMute: boolean }) => p.serverMute)));
    const seats = (await call("GET", `/channels/${f.a.id}/voice`, f.listener.token)).json().participants;
    expect(seats).toContainEqual({ userId: f.target.id, username: "target", sharing: false, serverMute: true, serverDeafen: false });
    expect(seats).toContainEqual({ userId: f.listener.id, username: "listener", sharing: false, serverMute: false, serverDeafen: false });
    await setState(f.mod, f.a, f.target.id, { mute: true }); // no change: nothing sent, nothing logged
    await settle();
    expect(target!.got["voice:moderated"]).toHaveLength(1);
    expect(mod!.got["voice:moderated"]).toEqual([]);
    expect(listener!.got["voice:moderated"]).toEqual([]);
  });

  it("writes one audit entry per changed flag, and one per move", async () => {
    const f = await fixture();
    await setState(f.mod, f.a, f.target.id, { mute: true, deafen: true });
    await setState(f.mod, f.a, f.target.id, { mute: false });
    await setState(f.mod, f.a, f.target.id, { deafen: false });
    expect((await call("POST", `/channels/${f.b.id}/voice/move`, f.owner.token, { userId: f.target.id })).statusCode).toBe(204);
    const entries = await prisma.auditLog.findMany({ where: { action: { startsWith: "voice." } }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => [e.action, e.actorId, e.targetUserId, e.targetId])).toEqual([
      ["voice.mute", f.mod.id, f.target.id, f.a.id],
      ["voice.deafen", f.mod.id, f.target.id, f.a.id],
      ["voice.unmute", f.mod.id, f.target.id, f.a.id],
      ["voice.undeafen", f.mod.id, f.target.id, f.a.id],
      ["voice.move", f.owner.id, f.target.id, f.b.id],
    ]);
    expect(entries[0]!.metadata).toEqual({ channel: "a" });
    expect(entries[4]!.metadata).toEqual({ channel: "b" });
  });
});
