import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, guildWith, resetDb, signUp as signUpUser } from "../../test/helpers.js";
import { type Client, connect as connectTo, listen, settle, until } from "../../test/sockets.js";

/** Presence v2: statuses, away flags, preference, guild co-member audience, privacy (invisible, blocks). */
const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
const EVENTS = ["presence:update", "me:status", "dm:new"];
let port: number;
const sockets: Socket[] = [];
const connect = (u: { token: string }) => connectTo(port, u.token, EVENTS, sockets);
const updates = (s: Client) => s.got["presence:update"]!;
const statuses = (s: Client, userId: string) => updates(s).filter((u) => u.userId === userId).map((u) => u.status);
const setStatus = (u: { token: string }, status: unknown) => call("PUT", "/me/status", u.token, { status });
const friendStatus = async (me: { token: string }) => {
  const f = (await call("GET", "/friends", me.token)).json().friends[0];
  return [f.status, f.online];
};
const memberStatus = async (me: { token: string }, guildId: string) =>
  Object.fromEntries(((await call("GET", `/guilds/${guildId}/members`, me.token)).json() as { username: string; status: string }[]).map((m) => [m.username, m.status]));

beforeAll(async () => {
  port = await listen(app);
});
beforeEach(resetDb);
afterEach(() => {
  sockets.splice(0).forEach((s) => s.disconnect());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("away flags", () => {
  it("online on connect, idle when the only socket goes away, online again, offline on the last disconnect", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const w = await connect(a);
    const s = await connect(b);
    await until(() => updates(w).length === 1);
    expect(updates(w)).toEqual([{ userId: b.id, online: true, status: "online" }]);
    s.emit("presence:away", { away: true });
    await until(() => updates(w).length === 2);
    expect(updates(w)[1]).toEqual({ userId: b.id, online: true, status: "idle" });
    expect(await friendStatus(a)).toEqual(["idle", true]);
    s.emit("presence:away", { away: true }); // no flip: nothing
    s.emit("presence:away", { away: false });
    await until(() => updates(w).length === 3);
    s.disconnect();
    await until(() => updates(w).length === 4);
    await settle();
    expect(statuses(w, b.id)).toEqual(["online", "idle", "online", "offline"]);
  });

  it("a second socket that is not away keeps the user online", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const w = await connect(a);
    const tab1 = await connect(b);
    tab1.emit("presence:away", { away: true });
    await until(() => updates(w).length === 2); // online, idle
    const tab2 = await connect(b); // an active tab: back to online
    await until(() => updates(w).length === 3);
    expect(await friendStatus(a)).toEqual(["online", true]);
    tab2.disconnect(); // only the away tab is left: idle
    await until(() => updates(w).length === 4);
    const tab3 = await connect(b);
    tab3.emit("presence:away", { away: true }); // every tab away: idle
    await until(() => updates(w).length === 6);
    tab1.emit("presence:away", { away: false }); // one active again
    await until(() => updates(w).length === 7);
    await settle();
    expect(statuses(w, b.id)).toEqual(["online", "idle", "online", "idle", "online", "idle", "online"]);
  });

  it("ignores malformed presence:away payloads", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const w = await connect(a);
    const s = await connect(b);
    await until(() => updates(w).length === 1);
    for (const bad of [undefined, null, true, "away", {}, { away: "true" }, { away: 1 }, { away: null }, { away: true, extra: 1 }, [true]]) s.emit("presence:away", bad);
    await settle();
    expect(updates(w)).toHaveLength(1);
    expect(await friendStatus(a)).toEqual(["online", true]);
    s.emit("presence:away", { away: true }); // control: the valid one still works
    await until(() => updates(w).length === 2);
  });
});

describe("status preference", () => {
  it("GET/PUT /me/status; dnd, idle and invisible propagate; the user's other sockets get me:status", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    expect((await call("GET", "/me/status", b.token)).json()).toEqual({ status: "online" });
    const w = await connect(a);
    const [mine, other] = [await connect(b), await connect(b)];
    await until(() => updates(w).length === 1);

    for (const [pref, seen] of [["dnd", "dnd"], ["idle", "idle"], ["invisible", "offline"], ["online", "online"]] as const) {
      const res = await setStatus(b, pref);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: pref });
      expect((await call("GET", "/me/status", b.token)).json()).toEqual({ status: pref });
      await until(() => statuses(w, b.id).at(-1) === seen);
      expect(await friendStatus(a)).toEqual([seen, seen !== "offline"]);
    }
    await until(() => other.got["me:status"]!.length === 4 && mine.got["me:status"]!.length === 4);
    expect(other.got["me:status"]).toEqual(["dnd", "idle", "invisible", "online"].map((status) => ({ status })));
    expect(updates(w).at(-2)).toEqual({ userId: b.id, online: false, status: "offline" });
    await settle();
    expect(statuses(w, b.id)).toEqual(["online", "dnd", "idle", "offline", "online"]);
    expect(updates(mine).filter((u) => u.userId === b.id)).toEqual([]); // never told about themself
  });

  it("no broadcast when the effective status does not change", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const w = await connect(a);
    const s = await connect(b);
    s.emit("presence:away", { away: true });
    await until(() => updates(w).length === 2); // online, idle
    await setStatus(b, "idle"); // idle by choice while already idle by away
    await setStatus(b, "idle");
    await settle();
    expect(updates(w)).toHaveLength(2);
    await setStatus(b, "dnd");
    await until(() => updates(w).length === 3);
    s.emit("presence:away", { away: false }); // dnd stays dnd
    await settle();
    expect(statuses(w, b.id)).toEqual(["online", "idle", "dnd"]);
  });

  it("a preference change while offline broadcasts nothing", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const w = await connect(a);
    await setStatus(b, "dnd");
    await settle();
    expect(updates(w)).toEqual([]);
    expect(await friendStatus(a)).toEqual(["offline", false]);
    await connect(b); // comes online as dnd
    await until(() => updates(w).length === 1);
    expect(updates(w)).toEqual([{ userId: b.id, online: true, status: "dnd" }]);
  });

  it("rejects malformed PUT bodies and keeps the preference", async () => {
    const b = await signUp("bob");
    await setStatus(b, "dnd");
    for (const body of [{}, { status: "offline" }, { status: "busy" }, { status: "DND" }, { status: 1 }, { status: null }, { status: "idle", extra: true }]) {
      expect((await call("PUT", "/me/status", b.token, body)).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "PUT", url: "/me/status", payload: '"idle"', headers: { authorization: `Bearer ${b.token}`, "content-type": "application/json" } })).statusCode).toBe(400);
    expect((await call("GET", "/me/status", b.token)).json()).toEqual({ status: "dnd" });
    await expect(prisma.user.update({ where: { id: b.id }, data: { statusPref: "offline" } })).rejects.toThrow(); // CHECK in the DB
  });
});

describe("privacy: invisible looks exactly like offline", () => {
  it("on presence:update, friends, DMs, members, POST /dms and dm:new; the invisible user still works normally", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await befriend(app, a, b);
    const { guild } = await guildWith(app, a, b);
    await setStatus(b, "invisible");
    const w = await connect(a);
    const sb = await connect(b);
    sb.emit("presence:away", { away: true });
    sb.emit("presence:away", { away: false });
    const dm = await call("POST", "/dms", a.token, { userId: b.id });
    expect(dm.json().user).toEqual({ id: b.id, username: "bob", displayName: null, avatarHash: null, online: false, status: "offline" });
    // bob uses the app: messages, opening a DM (alice is told of it with bob offline), reading lists.
    expect((await call("POST", `/dms/${dm.json().id}/messages`, b.token, { content: "hi" })).statusCode).toBe(201);
    const sc = await connect(c);
    expect((await call("POST", "/dms", b.token, { userId: c.id })).statusCode).toBe(404); // not friends: unrelated to presence
    await befriend(app, b, c);
    expect((await call("POST", "/dms", b.token, { userId: c.id })).statusCode).toBe(201);
    await until(() => sc.got["dm:new"]!.length);
    expect(sc.got["dm:new"]![0].user).toEqual({ id: b.id, username: "bob", displayName: null, avatarHash: null, online: false, status: "offline" });
    expect((await call("GET", "/friends", b.token)).statusCode).toBe(200);
    expect(await memberStatus(b, guild.id)).toEqual({ alice: "online", bob: "offline" }); // bob sees himself as others do

    expect(await friendStatus(a)).toEqual(["offline", false]);
    expect((await call("GET", "/dms", a.token)).json()[0].user).toMatchObject({ online: false, status: "offline" });
    expect(await memberStatus(a, guild.id)).toEqual({ alice: "online", bob: "offline" });
    sb.disconnect();
    await settle();
    expect(updates(w).filter((u) => u.userId === b.id)).toEqual([]); // not a single presence event about bob
  });
});

describe("audience", () => {
  it("a guild co-member who is not a friend receives updates; a stranger does not", async () => {
    const [owner, member, stranger] = await Promise.all([signUp("owner"), signUp("member"), signUp("stranger")]);
    const { guild } = await guildWith(app, owner, member);
    const [so, ss] = [await connect(owner), await connect(stranger)];
    const sm = await connect(member);
    await until(() => updates(so).length === 1);
    sm.emit("presence:away", { away: true });
    await setStatus(member, "dnd");
    sm.disconnect();
    await until(() => updates(so).length === 4);
    expect(statuses(so, member.id)).toEqual(["online", "idle", "dnd", "offline"]);
    expect(updates(ss)).toEqual([]);
    expect(updates(sm).filter((u) => u.userId === member.id), "never told about themself").toEqual([]);
    expect(await memberStatus(owner, guild.id)).toEqual({ owner: "online", member: "offline" });
  });

  it("GET members carries each member's status as the caller may see it", async () => {
    const [owner, dnd, away, ghost, gone] = await Promise.all(["owner", "dnd", "away", "ghost", "gone"].map(signUp));
    const { guild } = await guildWith(app, owner, dnd, away, ghost, gone);
    await setStatus(dnd, "dnd");
    await setStatus(ghost, "invisible");
    await Promise.all([owner, dnd, ghost].map(connect));
    (await connect(away)).emit("presence:away", { away: true });
    const want = { owner: "online", dnd: "dnd", away: "idle", ghost: "offline", gone: "offline" };
    await vi.waitFor(async () => expect(await memberStatus(owner, guild.id)).toEqual(want), { timeout: 3000, interval: 20 });
    await setStatus(owner, "dnd");
    expect(await memberStatus(owner, guild.id)).toEqual({ ...want, owner: "dnd" }); // the caller sees their own status
  });

  it("presence never crosses a block, in either direction, on any path", async () => {
    const [a, b, c, d] = await Promise.all(["alice", "bob", "carol", "dave"].map(signUp));
    const { guild } = await guildWith(app, a, b, c, d);
    await call("PUT", `/blocks/${b.id}`, a.token); // alice blocks bob
    await call("PUT", `/blocks/${a.id}`, c.token); // carol blocks alice
    const [sb, sc, sd] = [await connect(b), await connect(c), await connect(d)];
    await settle();
    const sa = await connect(a);
    sa.emit("presence:away", { away: true });
    await setStatus(a, "dnd");
    await until(() => updates(sd).filter((u) => u.userId === a.id).length === 3); // dave is the control
    sa.disconnect();
    await until(() => updates(sd).filter((u) => u.userId === a.id).length === 4);
    await settle();
    for (const s of [sb, sc]) expect(updates(s).filter((u) => u.userId === a.id)).toEqual([]);
    // ...and alice gets nothing about them either, nor sees them in lists.
    const sa2 = await connect(a);
    await settle();
    for (const s of [sb, sc, sd]) s.emit("presence:away", { away: true });
    await until(() => updates(sa2).some((u) => u.userId === d.id && u.status === "idle"));
    await settle();
    expect(updates(sa2).filter((u) => u.userId === b.id || u.userId === c.id)).toEqual([]);
    expect(await memberStatus(a, guild.id)).toEqual({ alice: "dnd", bob: "offline", carol: "offline", dave: "idle" });
    expect(await memberStatus(b, guild.id)).toMatchObject({ alice: "offline", carol: "idle" });
    expect(await memberStatus(c, guild.id)).toMatchObject({ alice: "offline", bob: "idle" });
  });
});
