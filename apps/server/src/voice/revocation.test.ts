import { DEFAULT_EVERYONE_PERMISSIONS, Permission as P } from "@loop/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, resetDb, setEveryone, signUp } from "../../test/helpers.js";
import { addVoiceChannel, disconnectAll, eventually, expectInRoom, identities, joinAs, publishMic, requestToken, RoomEvent, signedWebhook, testLivekit, webhookHeaders } from "../../test/voice.js";
import { voiceRoom } from "./rooms.js";

/** A live session must not outlast the rights it was admitted with. Everything runs against the real LiveKit. */
const app = buildApp(env);
const call = caller(app);

/** alice and bob are in the voice channel (media-connected); owner administers. */
async function fixture() {
  const [owner, alice, bob] = await Promise.all(["owner", "alice", "bob"].map((n) => signUp(app, n)));
  const { guild } = await guildWith(app, owner, alice, bob);
  const voice = await addVoiceChannel(app, owner, guild.id);
  const room = voiceRoom(voice.id);
  const rooms = {
    alice: await joinAs((await requestToken(app, alice, voice.id)).json()),
    bob: await joinAs((await requestToken(app, bob, voice.id)).json()),
  };
  await expectInRoom(room, [alice.id, bob.id]);
  return { owner, alice, bob, guild, voice, room, rooms };
}
type F = Awaited<ReturnType<typeof fixture>>;

const editEveryone = (f: F, permissions: number) => call("PATCH", `/guilds/${f.guild.id}/roles/${f.guild.id}`, f.owner.token, { permissions });
const gone = (f: F, ...ids: string[]) =>
  eventually(async () => expect((await identities(f.room)).filter((id) => ids.includes(id))).toEqual([]));

beforeEach(resetDb);
afterEach(disconnectAll);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("rights changes through the API reach live sessions", () => {
  it("losing CONNECT through a role permission edit removes the participant", async () => {
    const f = await fixture();
    expect((await editEveryone(f, DEFAULT_EVERYONE_PERMISSIONS & ~P.CONNECT)).statusCode).toBe(200);
    await gone(f, f.alice.id, f.bob.id);
  });

  it("losing SPEAK unpublishes the microphone but keeps the seat", async () => {
    const f = await fixture();
    let heard = 0;
    let dropped = 0;
    f.rooms.bob.on(RoomEvent.TrackSubscribed, () => heard++);
    f.rooms.bob.on(RoomEvent.TrackUnsubscribed, () => dropped++);
    expect(await publishMic(f.rooms.alice)).toBe("published");
    await eventually(() => expect(heard).toBe(1));
    await editEveryone(f, DEFAULT_EVERYONE_PERMISSIONS & ~P.SPEAK);
    await eventually(() => expect(dropped).toBe(1));
    const seat = (await testLivekit.participants(f.room)).find((s) => s.userId === f.alice.id)!;
    expect(seat).toMatchObject({ speak: false, video: true });
    expect(await publishMic(f.rooms.alice)).toBe("refused");
  });

  it("losing VIEW through a channel overwrite removes the participant", async () => {
    const f = await fixture();
    await call("PUT", `/channels/${f.voice.id}/overwrites/${f.guild.id}`, f.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    await gone(f, f.alice.id, f.bob.id);
  });

  it("a kick removes the participant, the other stays", async () => {
    const f = await fixture();
    expect((await call("DELETE", `/guilds/${f.guild.id}/members/${f.alice.id}`, f.owner.token)).statusCode).toBe(204);
    await gone(f, f.alice.id);
    expect(await identities(f.room)).toEqual([f.bob.id]);
  });

  it("leaving the guild removes the participant", async () => {
    const f = await fixture();
    await call("DELETE", `/guilds/${f.guild.id}/members/me`, f.bob.token);
    await gone(f, f.bob.id);
  });

  it("deleting the channel closes the room", async () => {
    const f = await fixture();
    expect((await call("DELETE", `/guilds/${f.guild.id}/channels/${f.voice.id}`, f.owner.token)).statusCode).toBe(204);
    await eventually(async () => expect(await testLivekit.listRooms([f.room])).toEqual([]));
  });

  it("deleting the guild closes the rooms of all its voice channels", async () => {
    const f = await fixture();
    const second = await addVoiceChannel(app, f.owner, f.guild.id, "second");
    await joinAs((await requestToken(app, f.owner, second.id)).json());
    await call("DELETE", `/guilds/${f.guild.id}`, f.owner.token);
    await eventually(async () => expect(await testLivekit.listRooms([f.room, voiceRoom(second.id)])).toEqual([]));
  });

  it("a role edit elsewhere (unrelated bit) leaves everybody in", async () => {
    const f = await fixture();
    await editEveryone(f, DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_MESSAGES);
    await new Promise((r) => setTimeout(r, 500));
    expect(await identities(f.room)).toEqual([f.alice.id, f.bob.id].sort());
  });
});

describe("reconcile() is the safety net", () => {
  it("removes whoever lost rights while the enforcement hook was bypassed (DB edited directly)", async () => {
    const f = await fixture();
    await setEveryone(f.guild.id, DEFAULT_EVERYONE_PERMISSIONS & ~P.CONNECT);
    expect(await identities(f.room)).toHaveLength(2); // nothing noticed yet
    await app.voice.reconcile();
    await gone(f, f.alice.id, f.bob.id);
  });

  it("downgrades a lost SPEAK and keeps VIDEO", async () => {
    const f = await fixture();
    await setEveryone(f.guild.id, DEFAULT_EVERYONE_PERMISSIONS & ~P.SPEAK);
    await app.voice.reconcile();
    await eventually(async () =>
      expect((await testLivekit.participants(f.room)).map((s) => [s.speak, s.video])).toEqual([[false, true], [false, true]]),
    );
  });

  it("closes the room of a channel that no longer exists", async () => {
    const f = await fixture();
    await prisma.channel.delete({ where: { id: f.voice.id } });
    await app.voice.reconcile();
    await eventually(async () => expect(await testLivekit.listRooms([f.room])).toEqual([]));
  });
});

describe("a token issued before the revocation", () => {
  it("gets the rejoiner removed as soon as LiveKit reports the join (signed webhook)", async () => {
    const f = await fixture();
    const stale = (await requestToken(app, f.alice, f.voice.id)).json(); // valid for 10 more minutes
    await call("DELETE", `/guilds/${f.guild.id}/members/${f.alice.id}`, f.owner.token);
    await gone(f, f.alice.id);
    await joinAs(stale);
    await expectInRoom(f.room, [f.alice.id, f.bob.id]); // LiveKit lets the old token in
    const { body, authorization } = await signedWebhook({
      event: "participant_joined",
      room: { name: f.room },
      participant: { identity: f.alice.id, name: "alice" },
    });
    const res = await app.inject({ method: "POST", url: "/livekit/webhook", payload: body, headers: webhookHeaders(authorization) });
    expect(res.statusCode).toBe(200);
    await gone(f, f.alice.id);
  });
});

describe("LiveKit unreachable", () => {
  it("does not fail the request that triggered the change, and logs a short error", async () => {
    const lines: string[] = [];
    const sink = new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) });
    const broken = buildApp({ ...env, livekit: { ...env.livekit, apiUrl: "http://127.0.0.1:1" } }, { level: "error", stream: sink });
    const [owner, alice] = await Promise.all(["owner", "alice"].map((n) => signUp(broken, n)));
    const { guild } = await guildWith(broken, owner, alice);
    await addVoiceChannel(broken, owner, guild.id);
    const res = await caller(broken)("PATCH", `/guilds/${guild.id}/roles/${guild.id}`, owner.token, { permissions: 0 });
    expect(res.statusCode).toBe(200);
    expect(lines.join("")).toMatch(/voice enforce failed/);
    expect(lines.join("")).not.toContain(env.livekit.apiSecret);
    await broken.close();
  });
});
