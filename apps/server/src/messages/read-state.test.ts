import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Permission as P } from "@loop/shared";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, guildWith, resetDb, signUp as signUpUser } from "../../test/helpers.js";
import { connect as connectTo, listen, settle, until } from "../../test/sockets.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
type U = Awaited<ReturnType<typeof signUp>>;
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

const unread = async (u: U) => (await call("GET", "/me/unread", u.token)).json() as { channels: any[]; dms: any[] };
const send = async (u: U, channelId: string, content: string) =>
  (await call("POST", `/channels/${channelId}/messages`, u.token, { content })).json() as { id: string; seq: string };
const read = (u: U, channelId: string, seq: string) => call("PUT", `/channels/${channelId}/read`, u.token, { seq });
const count = (channelId: string) => (u: { channels: any[] }) => u.channels.find((c) => c.channelId === channelId);

async function setup() {
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map(signUp));
  const { guild, general } = await guildWith(app, alice, bob, carol);
  const second = (await call("POST", `/guilds/${guild.id}/channels`, alice.token, { name: "second", type: "TEXT" })).json() as { id: string };
  return { alice, bob, carol, guild, general, second };
}

describe("GET /me/unread", () => {
  it("starts everything as read for a conversation with no state, then counts what arrives (own messages excluded)", async () => {
    const { alice, bob, guild, general } = await setup();
    await send(alice, general.id, "old 1");
    await send(alice, general.id, "old 2");
    expect(await unread(bob), "lazy initial state").toEqual({ channels: [], dms: [] });
    await unread(alice);
    await send(alice, general.id, "new 1");
    await send(bob, general.id, "mine");
    await send(alice, general.id, "new 2");
    expect((await unread(bob)).channels).toEqual([{ channelId: general.id, guildId: guild.id, unread: 2, mentions: 0 }]);
    expect((await unread(alice)).channels, "the author's own messages never count").toEqual([{ channelId: general.id, guildId: guild.id, unread: 1, mentions: 0 }]);
  });

  it("counts mentions and @everyone, but not your own mention-everyone", async () => {
    const { alice, bob, carol, general } = await setup();
    await unread(bob);
    await unread(carol);
    await send(alice, general.id, `hey <@${bob.id}>`);
    await send(alice, general.id, "@everyone listen");
    await send(alice, general.id, "plain");
    expect(count(general.id)(await unread(bob))).toMatchObject({ unread: 3, mentions: 2 });
    expect(count(general.id)(await unread(carol))).toMatchObject({ unread: 3, mentions: 1 });
    expect(count(general.id)(await unread(alice))).toBeUndefined();
  });

  it("caps both counts at 99", async () => {
    const { alice, bob, general } = await setup();
    await unread(bob);
    await prisma.message.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({ channelId: general.id, authorId: alice.id, content: `m${i}`, mentionEveryone: true })),
    });
    expect(count(general.id)(await unread(bob))).toMatchObject({ unread: 99, mentions: 99 });
  });

  it("lists only channels the caller can VIEW, and covers every server", async () => {
    const { alice, bob, guild, general } = await setup();
    const other = await guildWith(app, bob);
    const hidden = (await call("POST", `/guilds/${guild.id}/channels`, alice.token, { name: "hidden", type: "TEXT" })).json() as { id: string };
    await call("PUT", `/channels/${hidden.id}/overwrites/${guild.id}`, alice.token, { allow: 0, deny: P.VIEW_CHANNEL });
    await unread(bob);
    await send(alice, general.id, "a");
    await send(alice, hidden.id, "secret");
    const otherCarol = await signUp("dave");
    await call("POST", `/guilds/${other.guild.id}/invites`, bob.token, {}).then(async (r) => call("POST", `/invites/${r.json().code}/join`, otherCarol.token));
    await unread(bob);
    await send(otherCarol, other.general.id, "elsewhere");
    const result = await unread(bob);
    expect(result.channels.map((c) => c.channelId).sort()).toEqual([general.id, other.general.id].sort());
  });

  it("counts DMs, with mentions", async () => {
    const { alice, bob } = await setup();
    await befriend(app, alice, bob);
    const dm = (await call("POST", "/dms", alice.token, { userId: bob.id })).json() as { id: string };
    await unread(bob);
    await call("POST", `/dms/${dm.id}/messages`, alice.token, { content: "yo" });
    await call("POST", `/dms/${dm.id}/messages`, alice.token, { content: `<@${bob.id}>` });
    expect((await unread(bob)).dms).toEqual([{ dmChannelId: dm.id, unread: 2, mentions: 1 }]);
    expect((await unread(alice)).dms).toEqual([]);
  });

  it("stays fast with a few thousand messages (bounded range scans)", async () => {
    const { alice, bob, general, second } = await setup();
    await unread(bob);
    const rows = (channelId: string) => Array.from({ length: 3000 }, (_, i) => ({ channelId, authorId: alice.id, content: `m${i}` }));
    await prisma.message.createMany({ data: [...rows(general.id), ...rows(second.id)] });
    const started = performance.now();
    const result = await unread(bob);
    expect(result.channels.map((c) => c.unread)).toEqual([99, 99]);
    expect(performance.now() - started).toBeLessThan(1500); // generous: CI is slower than a laptop
  });
});

describe("PUT /channels/:id/read", () => {
  it("moves forward only, and the badge clears", async () => {
    const { alice, bob, general } = await setup();
    await unread(bob);
    const m1 = await send(alice, general.id, "1");
    const m2 = await send(alice, general.id, "2");
    const m3 = await send(alice, general.id, "3");
    expect((await read(bob, general.id, m2.seq)).statusCode).toBe(204);
    expect(count(general.id)(await unread(bob))).toMatchObject({ unread: 1 });
    expect((await read(bob, general.id, m1.seq)).statusCode, "older is ignored").toBe(204);
    expect(count(general.id)(await unread(bob))).toMatchObject({ unread: 1 });
    await read(bob, general.id, m3.seq);
    expect(count(general.id)(await unread(bob))).toBeUndefined();
  });

  it("clamps a seq beyond the newest message, so later messages still count", async () => {
    const { alice, bob, general } = await setup();
    await unread(bob);
    await send(alice, general.id, "1");
    await read(bob, general.id, "999999999999999999");
    await send(alice, general.id, "2");
    expect(count(general.id)(await unread(bob))).toMatchObject({ unread: 1 });
  });

  it("validates the body and the permission", async () => {
    const { alice, bob, guild, general } = await setup();
    const outsider = await signUp("outsider");
    expect((await call("PUT", `/channels/${general.id}/read`, bob.token, { seq: "abc" })).statusCode).toBe(400);
    expect((await call("PUT", `/channels/${general.id}/read`, bob.token, { seq: "1", extra: 1 })).statusCode).toBe(400);
    expect((await read(outsider, general.id, "1")).statusCode, "not a member").toBe(404);
    await call("PUT", `/channels/${general.id}/overwrites/${guild.id}`, alice.token, { allow: 0, deny: P.VIEW_CHANNEL });
    expect((await read(bob, general.id, "1")).statusCode, "no VIEW").toBe(404);
    expect(await prisma.readState.count({ where: { userId: bob.id, channelId: general.id } })).toBe(0);
  });

  it("tells the user's other devices with read:updated, and nobody else", async () => {
    const { alice, bob, general } = await setup();
    const [b1, b2, a1] = await Promise.all([bob, bob, alice].map((u) => connectTo(port, u.token, ["read:updated"], sockets)));
    const m = await send(alice, general.id, "1");
    await read(bob, general.id, m.seq);
    await until(() => b1.got["read:updated"]!.length && b2.got["read:updated"]!.length);
    expect(b2.got["read:updated"]).toEqual([{ channelId: general.id, lastReadSeq: m.seq }]);
    await read(bob, general.id, m.seq); // no change: nothing announced
    await settle();
    expect(b1.got["read:updated"]).toHaveLength(1);
    expect(a1.got["read:updated"]).toEqual([]);
  });

  it("has one row per user and conversation however often it is called", async () => {
    const { alice, bob, general } = await setup();
    const m = await send(alice, general.id, "1");
    await Promise.all([read(bob, general.id, m.seq), read(bob, general.id, m.seq), unread(bob)]);
    expect(await prisma.readState.count({ where: { userId: bob.id, channelId: general.id } })).toBe(1);
  });
});

describe("PUT /dms/:id/read", () => {
  it("works for participants only and clears the DM badge", async () => {
    const { alice, bob, carol } = await setup();
    await befriend(app, alice, bob);
    const dm = (await call("POST", "/dms", alice.token, { userId: bob.id })).json() as { id: string };
    await unread(bob);
    const m = (await call("POST", `/dms/${dm.id}/messages`, alice.token, { content: "yo" })).json();
    expect((await call("PUT", `/dms/${dm.id}/read`, carol.token, { seq: m.seq })).statusCode).toBe(404);
    expect((await call("PUT", `/dms/${dm.id}/read`, bob.token, { seq: m.seq })).statusCode).toBe(204);
    expect((await unread(bob)).dms).toEqual([]);
  });
});
