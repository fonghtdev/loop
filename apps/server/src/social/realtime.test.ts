import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, resetDb, signUp as signUpUser } from "../../test/helpers.js";
import { connect as connectTo, listen, settle, until } from "../../test/sockets.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
const EVENTS = ["dm:message:new", "dm:message:update", "dm:message:delete", "dm:new", "friend:request", "friend:accepted", "friend:removed", "presence:update"];
let port: number;
const sockets: Socket[] = [];
const connect = (u: { token: string }) => connectTo(port, u.token, EVENTS, sockets);
const count = (s: { got: Record<string, any[]> }) => Object.values(s.got).flat().length;

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

describe("friend events", () => {
  it("request, accept and removal reach the right users only", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    const [sa, sb, sc] = await Promise.all([connect(a), connect(b), connect(c)]);
    await settle(); // drop the presence noise of connecting before asserting

    await call("POST", "/friends/requests", a.token, { username: "bob" });
    await until(() => sb.got["friend:request"]!.length);
    expect(sb.got["friend:request"]).toEqual([{ from: { id: a.id, username: "alice" } }]);

    await call("POST", `/friends/requests/${a.id}/accept`, b.token);
    await until(() => sa.got["friend:accepted"]!.length && sb.got["friend:accepted"]!.length);
    expect(sa.got["friend:accepted"]).toEqual([{ user: { id: b.id, username: "bob" } }]);
    expect(sb.got["friend:accepted"]).toEqual([{ user: { id: a.id, username: "alice" } }]);

    await call("DELETE", `/friends/${b.id}`, a.token);
    await until(() => sb.got["friend:removed"]!.length);
    expect(sb.got["friend:removed"]).toEqual([{ userId: a.id }]);
    expect(sa.got["friend:removed"]).toEqual([]);
    await settle();
    expect(count(sc)).toBe(0); // the third user saw nothing
  });

  it("an auto-accepting request tells both sides they are friends", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    const [sa, sb] = await Promise.all([connect(a), connect(b)]);
    await call("POST", "/friends/requests", a.token, { username: "bob" });
    await call("POST", "/friends/requests", b.token, { username: "alice" });
    await until(() => sa.got["friend:accepted"]!.length && sb.got["friend:accepted"]!.length);
  });

  it("blocking tells the blocked user nothing", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const sb = await connect(b);
    await settle();
    const before = count(sb);
    await call("PUT", `/blocks/${b.id}`, a.token);
    await settle();
    expect(count(sb)).toBe(before);
  });
});

describe("DM events", () => {
  it("both participants' sockets get new/update/delete; a third user gets nothing", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await befriend(app, a, b);
    const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json();
    const [sa, sb2, sb, sc] = await Promise.all([connect(a), connect(b), connect(b), connect(c)]);
    await settle();
    const before = count(sc);

    const msg = (await call("POST", `/dms/${dm.id}/messages`, a.token, { content: "hi" })).json();
    await until(() => [sa, sb, sb2].every((s) => s.got["dm:message:new"]!.length));
    for (const s of [sa, sb, sb2]) expect(s.got["dm:message:new"]).toEqual([msg]); // sender and both of bob's tabs

    const edited = (await call("PATCH", `/messages/${msg.id}`, a.token, { content: "hi!" })).json();
    await until(() => sb.got["dm:message:update"]!.length && sa.got["dm:message:update"]!.length);
    expect(sb.got["dm:message:update"]).toEqual([edited]);

    await call("DELETE", `/messages/${msg.id}`, a.token);
    await until(() => sb.got["dm:message:delete"]!.length && sa.got["dm:message:delete"]!.length);
    expect(sb.got["dm:message:delete"]).toEqual([{ id: msg.id, dmChannelId: dm.id }]);
    await settle();
    expect(count(sc)).toBe(before);
  });

  it("dm:new goes to the other participant on first creation only", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const [sa, sb] = await Promise.all([connect(a), connect(b)]);
    const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json();
    await call("POST", "/dms", a.token, { userId: b.id });
    await call("POST", "/dms", b.token, { userId: a.id });
    await until(() => sb.got["dm:new"]!.length);
    await settle();
    expect(sb.got["dm:new"]).toEqual([{ id: dm.id, user: { id: a.id, username: "alice", online: true } }]);
    expect(sa.got["dm:new"]).toEqual([]);
  });

  it("a refused send (not friends) emits nothing", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json();
    await call("DELETE", `/friends/${b.id}`, a.token);
    const sb = await connect(b);
    await settle();
    const before = count(sb);
    expect((await call("POST", `/dms/${dm.id}/messages`, a.token, { content: "x" })).statusCode).toBe(403);
    await settle();
    expect(count(sb)).toBe(before);
  });
});

describe("presence", () => {
  const presence = (s: { got: Record<string, any[]> }) => s.got["presence:update"]!;

  it("a friend sees online on the first socket and offline on the last, not for extra tabs", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    const watcher = await connect(a);
    const tab1 = await connect(b);
    await until(() => presence(watcher).length);
    expect(presence(watcher)).toEqual([{ userId: b.id, online: true }]);

    const tab2 = await connect(b);
    tab2.disconnect(); // a second tab coming and going changes nothing
    await settle();
    expect(presence(watcher)).toHaveLength(1);

    tab1.disconnect();
    await until(() => presence(watcher).length === 2);
    expect(presence(watcher)[1]).toEqual({ userId: b.id, online: false });
  });

  it("GET /friends and GET /dms report online correctly", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    await call("POST", "/dms", a.token, { userId: b.id });
    const online = async () => [(await call("GET", "/friends", a.token)).json().friends[0].online, (await call("GET", "/dms", a.token)).json()[0].user.online];
    expect(await online()).toEqual([false, false]);
    const s = await connect(b);
    expect(await online()).toEqual([true, true]);
    s.disconnect();
    await vi.waitFor(async () => expect(await online()).toEqual([false, false]), { timeout: 3000, interval: 20 });
  });

  it("GET /dms never shows a user online across a block, in either direction", async () => {
    const [a, b, c, d] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol"), signUp("dave")]);
    for (const other of [b, c, d]) await befriend(app, a, other);
    for (const other of [b, c, d]) await call("POST", "/dms", a.token, { userId: other.id });
    await Promise.all([a, b, c, d].map(connect));
    await call("PUT", `/blocks/${b.id}`, a.token); // alice blocks bob
    await call("PUT", `/blocks/${a.id}`, c.token); // carol blocks alice
    const online = async (me: typeof a) =>
      Object.fromEntries(((await call("GET", "/dms", me.token)).json() as { user: { username: string; online: boolean } }[]).map((r) => [r.user.username, r.user.online]));
    expect(await online(a)).toEqual({ bob: false, carol: false, dave: true }); // dave is the control: still visible
    expect(await online(b)).toEqual({ alice: false });
    expect(await online(c)).toEqual({ alice: false });
  });

  it("non-friends and pending requests get no presence", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await call("POST", "/friends/requests", c.token, { username: "bob" }); // pending only
    const [sa, sc] = await Promise.all([connect(a), connect(c)]);
    const sb = await connect(b);
    sb.disconnect();
    await settle();
    expect(presence(sa)).toEqual([]);
    expect(presence(sc)).toEqual([]);
  });

  it("no presence after unfriend or block (a block ends the friendship)", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await befriend(app, a, b);
    await befriend(app, a, c);
    await call("DELETE", `/friends/${b.id}`, a.token);
    await call("PUT", `/blocks/${c.id}`, a.token);
    expect(await prisma.friendship.count()).toBe(0);
    const sa = await connect(a);
    const [sb, sc] = await Promise.all([connect(b), connect(c)]);
    sb.disconnect();
    sc.disconnect();
    await settle();
    expect(presence(sa)).toEqual([]);
    expect(await call("GET", "/friends", a.token).then((r) => r.json().friends)).toEqual([]);
  });
});
