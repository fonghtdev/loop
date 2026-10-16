import { Permission as P } from "@loop/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, makeRole, resetDb, signUp } from "../../test/helpers.js";
import { connect, listen, settle, until } from "../../test/sockets.js";
import { addVoiceChannel, disconnectAll, expectInRoom, joinAs, requestToken, testLivekit } from "../../test/voice.js";
import { voiceRoom } from "./rooms.js";

const app = buildApp(env);
const call = caller(app);
const sockets: Socket[] = [];

/** mod (holds MOVE_MEMBERS through a role) and alice sit in room1; room2 is empty; bob is a plain member. */
async function fixture() {
  const [owner, mod, alice, bob, outsider] = await Promise.all(["owner", "mod", "alice", "bob", "outsider"].map((n) => signUp(app, n)));
  const { guild, general } = await guildWith(app, owner, mod, alice, bob);
  await makeRole(guild.id, 1, P.MOVE_MEMBERS, [mod.id]);
  const room1 = await addVoiceChannel(app, owner, guild.id, "room1");
  const room2 = await addVoiceChannel(app, owner, guild.id, "room2");
  await joinAs((await requestToken(app, alice, room1.id)).json());
  await expectInRoom(voiceRoom(room1.id), [alice.id]);
  return { owner, mod, alice, bob, outsider, guild, general, room1, room2 };
}
type F = Awaited<ReturnType<typeof fixture>>;
const move = (who: { token: string }, to: { id: string }, userId: string) =>
  call("POST", `/channels/${to.id}/voice/move`, who.token, { userId });

beforeEach(resetDb);
afterEach(async () => {
  await disconnectAll();
  sockets.splice(0).forEach((s) => s.close());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("POST /channels/:id/voice/move", () => {
  it("204 and only the target hears voice:moved, with the destination and who did it", async () => {
    const f = await fixture();
    const port = await listen(app);
    const [target, actor, other] = await Promise.all([f.alice, f.mod, f.bob].map((u) => connect(port, u.token, ["voice:moved"], sockets)));
    expect((await move(f.mod, f.room2, f.alice.id)).statusCode).toBe(204);
    await until(() => target!.got["voice:moved"]!.length === 1);
    expect(target!.got["voice:moved"]![0]).toEqual({ channelId: f.room2.id, by: { id: f.mod.id, username: "mod" } });
    await settle();
    expect(actor!.got["voice:moved"]).toEqual([]);
    expect(other!.got["voice:moved"]).toEqual([]);
  });

  it("the owner may move without a role", async () => {
    const f = await fixture();
    expect((await move(f.owner, f.room2, f.alice.id)).statusCode).toBe(204);
  });

  it("401 unauthenticated, 404 for outsiders and hidden destinations, 403 without MOVE_MEMBERS in the destination", async () => {
    const f = await fixture();
    expect((await call("POST", `/channels/${f.room2.id}/voice/move`, undefined, { userId: f.alice.id })).statusCode).toBe(401);
    expect((await move(f.outsider, f.room2, f.alice.id)).statusCode).toBe(404);
    expect((await move(f.bob, f.room2, f.alice.id)).statusCode).toBe(403);
    await call("PUT", `/channels/${f.room2.id}/overwrites/${f.guild.id}`, f.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    expect((await move(f.bob, f.room2, f.alice.id)).statusCode).toBe(404);
  });

  it("403 when the caller lacks MOVE_MEMBERS in the channel the target sits in (denied by overwrite)", async () => {
    const f = await fixture();
    const role = await prisma.role.findFirstOrThrow({ where: { guildId: f.guild.id, id: { not: f.guild.id } } });
    await call("PUT", `/channels/${f.room1.id}/overwrites/${role.id}`, f.owner.token, { allow: 0, deny: P.MOVE_MEMBERS });
    expect((await move(f.mod, f.room2, f.alice.id)).statusCode).toBe(403);
    expect((await move(f.owner, f.room2, f.alice.id)).statusCode).toBe(204);
  });

  it("403 when the caller lacks MOVE_MEMBERS in the destination only", async () => {
    const f = await fixture();
    const role = await prisma.role.findFirstOrThrow({ where: { guildId: f.guild.id, id: { not: f.guild.id } } });
    await call("PUT", `/channels/${f.room2.id}/overwrites/${role.id}`, f.owner.token, { allow: 0, deny: P.MOVE_MEMBERS });
    expect((await move(f.mod, f.room2, f.alice.id)).statusCode).toBe(403);
  });

  it("400 for a text destination and for a bad body", async () => {
    const f = await fixture();
    expect((await move(f.owner, f.general, f.alice.id)).statusCode).toBe(400);
    expect((await move(f.owner, f.room2, "nope")).statusCode).toBe(400);
  });

  it("409 when the target is in no voice channel, 404 for a non-member or a member of another guild", async () => {
    const f = await fixture();
    expect((await move(f.owner, f.room2, f.bob.id)).statusCode).toBe(409);
    expect((await move(f.owner, f.room2, f.outsider.id)).statusCode).toBe(404);
    expect((await move(f.owner, f.room2, "6f1d1f0e-0000-4000-8000-000000000000")).statusCode).toBe(404);
  });

  it("409 when the target is already in the destination", async () => {
    const f = await fixture();
    expect((await move(f.owner, f.room1, f.alice.id)).statusCode).toBe(409);
  });

  it("403 when the target cannot CONNECT to the destination", async () => {
    const f = await fixture();
    await call("PUT", `/channels/${f.room2.id}/overwrites/${f.guild.id}`, f.owner.token, { allow: 0, deny: P.CONNECT });
    const res = await move(f.owner, f.room2, f.alice.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Member cannot join that channel");
  });

  it("409 when the destination is full (room pre-created with 1 seat)", async () => {
    const f = await fixture();
    await testLivekit.ensureRoom(voiceRoom(f.room2.id), 1, { emptyTimeout: 60, departureTimeout: 5 });
    await joinAs((await requestToken(app, f.bob, f.room2.id)).json());
    await expectInRoom(voiceRoom(f.room2.id), [f.bob.id]);
    expect((await move(f.owner, f.room2, f.alice.id)).statusCode).toBe(409);
  });
});
