import { io, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, resetDb, signUp as signUpUser } from "../../test/helpers.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
let port: number;
const sockets: Socket[] = [];

beforeAll(async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});
beforeEach(resetDb);
afterEach(() => {
  sockets.splice(0).forEach((s) => s.disconnect());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

type Ack = { ok: boolean; error?: string };
type Client = Socket & { got: Record<string, any[]> };

/** Connected socket that records every message:* event it receives. */
async function connect(token: string): Promise<Client> {
  const s = io(`http://127.0.0.1:${port}`, { auth: { token }, reconnection: false, forceNew: true }) as Client;
  s.got = { "message:new": [], "message:update": [], "message:delete": [] };
  for (const event of Object.keys(s.got)) s.on(event, (p) => s.got[event]!.push(p));
  sockets.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once("connect", resolve);
    s.once("connect_error", reject);
  });
  return s;
}
const subscribe = (s: Socket, channelId: unknown) => s.emitWithAck("channel:subscribe", { channelId }) as Promise<Ack>;
const until = (check: () => unknown) => vi.waitFor(() => expect(check()).toBeTruthy(), { timeout: 2000, interval: 10 });
const settle = () => new Promise((r) => setTimeout(r, 100)); // for "nothing arrives" assertions

async function setup() {
  const [owner, member, outsider] = await Promise.all([signUp("owner"), signUp("member"), signUp("outsider")]);
  const { guild, channels } = (await call("POST", "/guilds", owner.token, { name: "HQ" })).json();
  const code = (await call("POST", `/guilds/${guild.id}/invites`, owner.token, {})).json().code;
  await call("POST", `/invites/${code}/join`, member.token);
  return { owner, member, outsider, guild, channel: channels[0], url: `/channels/${channels[0].id}/messages` };
}

describe("handshake and subscribe", () => {
  it("refuses sockets without a valid token", async () => {
    await expect(connect("")).rejects.toThrow("Unauthorized");
    await expect(connect("garbage")).rejects.toThrow("Unauthorized");
  });

  it("a member subscribes (ack ok); a non-member, unknown and malformed ids are refused", async () => {
    const { member, outsider, channel } = await setup();
    expect(await subscribe(await connect(member.token), channel.id)).toEqual({ ok: true });
    const out = await connect(outsider.token);
    expect(await subscribe(out, channel.id)).toEqual({ ok: false, error: "Not found" });
    expect(await subscribe(out, "00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false });
    expect(await subscribe(out, "nope")).toMatchObject({ ok: false });
    expect(await subscribe(out, 42)).toMatchObject({ ok: false });
  });

  it("a refused subscriber receives nothing", async () => {
    const { owner, outsider, channel, url } = await setup();
    const out = await connect(outsider.token);
    await subscribe(out, channel.id);
    const ownerSock = await connect(owner.token);
    await subscribe(ownerSock, channel.id);
    await call("POST", url, owner.token, { content: "secret" });
    await until(() => ownerSock.got["message:new"]!.length);
    await settle();
    expect(out.got["message:new"]).toEqual([]);
  });
});

describe("events", () => {
  it("subscribers get new/update/delete, the unsubscribed get nothing, unsubscribe stops delivery", async () => {
    const { owner, member, channel, url } = await setup();
    const [a, b, idle] = await Promise.all([connect(owner.token), connect(member.token), connect(member.token)]);
    await subscribe(a, channel.id);
    await subscribe(b, channel.id);

    const msg = (await call("POST", url, owner.token, { content: "hi" })).json();
    await until(() => a.got["message:new"]!.length && b.got["message:new"]!.length);
    expect(a.got["message:new"]![0]).toEqual(msg); // sender gets its own event too
    expect(b.got["message:new"]![0]).toEqual(msg);

    const edited = (await call("PATCH", `/messages/${msg.id}`, owner.token, { content: "hi!" })).json();
    await until(() => b.got["message:update"]!.length);
    expect(b.got["message:update"]![0]).toEqual(edited);

    await call("DELETE", `/messages/${msg.id}`, member.token).then((r) => expect(r.statusCode).toBe(403));
    await call("DELETE", `/messages/${msg.id}`, owner.token);
    await until(() => b.got["message:delete"]!.length);
    expect(b.got["message:delete"]![0]).toEqual({ id: msg.id, channelId: channel.id });

    await b.emitWithAck("channel:unsubscribe", { channelId: channel.id });
    await call("POST", url, owner.token, { content: "after unsubscribe" });
    await until(() => a.got["message:new"]!.length === 2);
    await settle();
    expect(b.got["message:new"]).toHaveLength(1);
    expect(idle.got["message:new"]).toEqual([]);
  });

  it("a failed write emits nothing", async () => {
    const { owner, channel, url } = await setup();
    const a = await connect(owner.token);
    await subscribe(a, channel.id);
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_insert BEFORE INSERT ON "Message" FOR EACH ROW EXECUTE FUNCTION fail_insert()`);
    try {
      expect((await call("POST", url, owner.token, { content: "lost" })).statusCode).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER fail_insert ON "Message"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION fail_insert()`);
    }
    await call("POST", url, owner.token, { content: "ok" });
    await until(() => a.got["message:new"]!.length);
    await settle();
    expect(a.got["message:new"]!.map((m) => m.content)).toEqual(["ok"]);
  });
});

describe("losing access cuts the live feed", () => {
  /** A subscribed former-member-to-be and a still-subscribed owner as control. */
  async function subscribed() {
    const s = await setup();
    const member = await connect(s.member.token);
    const owner = await connect(s.owner.token);
    await Promise.all([subscribe(member, s.channel.id), subscribe(owner, s.channel.id)]);
    return { ...s, memberSock: member, ownerSock: owner };
  }
  const expectSilent = async (sock: Client, control: Client, post: () => unknown) => {
    const before = control.got["message:new"]!.length;
    await post();
    await until(() => control.got["message:new"]!.length > before);
    await settle();
    expect(sock.got["message:new"]).toEqual([]);
  };

  it("leaving the guild", async () => {
    const s = await subscribed();
    expect((await call("DELETE", `/guilds/${s.guild.id}/members/me`, s.member.token)).statusCode).toBe(204);
    await expectSilent(s.memberSock, s.ownerSock, () => call("POST", s.url, s.owner.token, { content: "private" }));
  });

  it("deleting the guild", async () => {
    const s = await subscribed();
    const extra = await connect(s.owner.token);
    await subscribe(extra, s.channel.id);
    await call("DELETE", `/guilds/${s.guild.id}`, s.owner.token);
    // The room is gone, so push straight at it: nobody may still be in it.
    app.realtime.emit(s.channel.id, "message:new", { content: "ghost" });
    await settle();
    for (const sock of [s.memberSock, s.ownerSock, extra]) expect(sock.got["message:new"]).toEqual([]);
  });

  it("deleting the channel", async () => {
    const s = await subscribed();
    const second = (await call("POST", `/guilds/${s.guild.id}/channels`, s.owner.token, { name: "two", type: "TEXT" })).json();
    await subscribe(s.memberSock, second.id);
    await call("DELETE", `/guilds/${s.guild.id}/channels/${second.id}`, s.owner.token);
    app.realtime.emit(second.id, "message:new", { content: "ghost" });
    await settle();
    expect(s.memberSock.got["message:new"]).toEqual([]);
    // the other channel's room is untouched
    await call("POST", s.url, s.owner.token, { content: "still live" });
    await until(() => s.memberSock.got["message:new"]!.length);
  });
});

describe("reconnect catch-up", () => {
  it("GET ?after=<last seq> returns exactly the messages missed, in order", async () => {
    const { owner, member, channel, url } = await setup();
    let sock = await connect(member.token);
    await subscribe(sock, channel.id);
    await call("POST", url, owner.token, { content: "seen" });
    await until(() => sock.got["message:new"]!.length);
    const lastSeq = sock.got["message:new"]![0].seq;

    sock.disconnect();
    for (const c of ["missed1", "missed2", "missed3"]) await call("POST", url, owner.token, { content: c });

    sock = await connect(member.token);
    await subscribe(sock, channel.id);
    const { messages } = (await call("GET", `${url}?after=${lastSeq}`, member.token)).json();
    expect(messages.map((m: { content: string }) => m.content)).toEqual(["missed1", "missed2", "missed3"]);
    await call("POST", url, owner.token, { content: "live" });
    await until(() => sock.got["message:new"]!.length);
    expect(sock.got["message:new"]![0].content).toBe("live"); // live feed resumes after the catch-up
  });
});
