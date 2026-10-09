import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { prisma } from "./db.js";
import { befriend, caller, env, guildWith, resetDb, signUp as signUpUser } from "../test/helpers.js";
import { connect as connectTo, listen, settle, until } from "../test/sockets.js";

/** Two server instances on their own ports, sharing Postgres and Redis (the Socket.IO adapter). */
const instA = buildApp(env);
const instB = buildApp(env);
const onA = caller(instA);
const onB = caller(instB);
const EVENTS = ["message:new", "dm:message:new", "presence:update"];
let portA: number;
let portB: number;
const sockets: Socket[] = [];

beforeAll(async () => {
  [portA, portB] = await Promise.all([listen(instA), listen(instB)]);
});
beforeEach(resetDb);
afterEach(() => {
  sockets.splice(0).forEach((s) => s.disconnect());
});
afterAll(async () => {
  await Promise.all([instA.close(), instB.close()]);
  await prisma.$disconnect();
});

const signUp = (name: string) => signUpUser(instA, name);
const sockA = (u: { token: string }) => connectTo(portA, u.token, EVENTS, sockets);
const sockB = (u: { token: string }) => connectTo(portB, u.token, EVENTS, sockets);

describe("two instances sharing Redis", () => {
  it("a guild message POSTed to B reaches a subscriber connected to A", async () => {
    const [owner, member] = await Promise.all([signUp("owner"), signUp("member")]);
    const { general } = await guildWith(instA, owner, member);
    const s = await sockA(member);
    expect(await s.emitWithAck("channel:subscribe", { channelId: general.id })).toEqual({ ok: true });

    const res = await onB("POST", `/channels/${general.id}/messages`, owner.token, { content: "across" });
    await until(() => s.got["message:new"]!.length);
    expect(s.got["message:new"]).toEqual([res.json()]);
  });

  it("a revoke issued on B removes the socket connected to A from the room", async () => {
    const [owner, member] = await Promise.all([signUp("owner"), signUp("member")]);
    const { guild, general } = await guildWith(instA, owner, member);
    const [victim, control] = await Promise.all([sockA(member), sockA(owner)]);
    for (const s of [victim, control]) await s.emitWithAck("channel:subscribe", { channelId: general.id });

    expect((await onB("DELETE", `/guilds/${guild.id}/members/${member.id}`, owner.token)).statusCode).toBe(204); // kick, on B
    await onB("POST", `/channels/${general.id}/messages`, owner.token, { content: "private" });
    await until(() => control.got["message:new"]!.length);
    await settle();
    expect(victim.got["message:new"]).toEqual([]);
  });

  it("a DM sent on B reaches both participants on A", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(instA, a, b);
    const dm = (await onA("POST", "/dms", a.token, { userId: b.id })).json();
    const [sa, sb] = await Promise.all([sockA(a), sockA(b)]);
    const msg = (await onB("POST", `/dms/${dm.id}/messages`, a.token, { content: "hello" })).json();
    await until(() => sa.got["dm:message:new"]!.length && sb.got["dm:message:new"]!.length);
    expect(sb.got["dm:message:new"]).toEqual([msg]);
  });

  it("presence spans instances: online/offline seen on the other one, extra tabs silent", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(instA, a, b);
    const watcher = await sockB(a);
    const tab1 = await sockA(b);
    await until(() => watcher.got["presence:update"]!.length);
    expect(watcher.got["presence:update"]).toEqual([{ userId: b.id, online: true }]);
    expect((await onB("GET", "/friends", a.token)).json().friends[0].online).toBe(true); // computed from the adapter

    const tab2 = await sockB(b); // second tab, on the other instance
    tab2.disconnect();
    await settle();
    expect(watcher.got["presence:update"]).toHaveLength(1);

    tab1.disconnect();
    await until(() => watcher.got["presence:update"]!.length === 2);
    expect(watcher.got["presence:update"]![1]).toEqual({ userId: b.id, online: false });
    await vi.waitFor(async () => expect((await onB("GET", "/friends", a.token)).json().friends[0].online).toBe(false), { timeout: 3000 });
  });

  it("closing one instance leaves the other's sockets connected", async () => {
    const lone = buildApp(env);
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    const lonePort = await listen(lone);
    const stays = await sockA(a);
    const goes = await connectTo(lonePort, b.token, EVENTS, sockets);
    await lone.close();
    await until(() => goes.disconnected);
    expect(stays.connected).toBe(true);
  });
});
