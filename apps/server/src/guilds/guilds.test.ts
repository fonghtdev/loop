import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { env } from "../../test/helpers.js";

const app = buildApp(env);

type Method = "GET" | "POST" | "DELETE";
const call = (method: Method, url: string, token?: string, payload?: object) =>
  app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });

const signUp = async (name: string) =>
  (
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: `${name}@example.com`, username: name, password: "correct-horse" },
    })
  ).json().accessToken as string;

async function setup() {
  const [owner, other, third] = await Promise.all([signUp("owner"), signUp("other"), signUp("third")]);
  const { guild, channels } = (await call("POST", "/guilds", owner, { name: "Loop HQ" })).json();
  return { owner, other, third, guild, general: channels[0], base: `/guilds/${guild.id}` };
}
const invite = async (token: string, base: string, body: object = {}) =>
  (await call("POST", `${base}/invites`, token, body)).json();
const join = (token: string, code: string) => call("POST", `/invites/${code}/join`, token);
const uses = async (code: string) => (await prisma.invite.findUniqueOrThrow({ where: { code } })).uses;

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE "Invite", "Member", "Channel", "Guild", "Session", "User" CASCADE`;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("guilds", () => {
  it("create gives the owner a member row and a general text channel", async () => {
    const res = await call("POST", "/guilds", await signUp("nam"), { name: "  Team  " });
    expect(res.statusCode).toBe(201);
    const { guild, channels } = res.json();
    expect(guild.name).toBe("Team");
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ name: "general", type: "TEXT", position: 0 });
    expect(await prisma.member.count({ where: { guildId: guild.id, userId: guild.ownerId } })).toBe(1);
  });

  it("400 on an empty name", async () => {
    expect((await call("POST", "/guilds", await signUp("nam"), { name: " " })).statusCode).toBe(400);
  });

  it("lists only the guilds I belong to", async () => {
    const { owner, other } = await setup();
    await call("POST", "/guilds", other, { name: "Mine" });
    const mine = (await call("GET", "/guilds", owner)).json();
    expect(mine.map((g: { name: string }) => g.name)).toEqual(["Loop HQ"]);
  });

  it("get returns guild and channels to members", async () => {
    const { owner, base, guild } = await setup();
    const body = (await call("GET", base, owner)).json();
    expect(body.guild.id).toBe(guild.id);
    expect(body.channels).toHaveLength(1);
  });

  it("owner deletes the guild with cascade; a member gets 403", async () => {
    const { owner, other, base, guild } = await setup();
    await join(other, (await invite(owner, base)).code);
    expect((await call("DELETE", base, other)).statusCode).toBe(403);
    expect((await call("DELETE", base, owner)).statusCode).toBe(204);
    expect((await call("GET", base, owner)).statusCode).toBe(404);
    expect(await prisma.channel.count({ where: { guildId: guild.id } })).toBe(0);
    expect(await prisma.member.count({ where: { guildId: guild.id } })).toBe(0);
  });

  it("non-members get 404 on every guild-scoped route", async () => {
    const { other, base, general } = await setup();
    const routes: [Method, string, object?][] = [
      ["GET", base],
      ["DELETE", base],
      ["POST", `${base}/channels`, { name: "x", type: "TEXT" }],
      ["DELETE", `${base}/channels/${general.id}`],
      ["GET", `${base}/members`],
      ["POST", `${base}/invites`, {}],
      ["DELETE", `${base}/members/me`],
    ];
    for (const [method, url, payload] of routes) {
      expect((await call(method, url, other, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
    const missing = await call("GET", "/guilds/00000000-0000-4000-8000-000000000000", other);
    expect((await call("GET", base, other)).body).toBe(missing.body);
    expect((await call("GET", "/guilds/not-a-uuid", other)).statusCode).toBe(404);
  });

  it("401 without a token", async () => {
    const { base } = await setup();
    expect((await call("GET", "/guilds")).statusCode).toBe(401);
    expect((await call("POST", "/guilds", undefined, { name: "x" })).statusCode).toBe(401);
    expect((await call("GET", `${base}/members`, "garbage")).statusCode).toBe(401);
    expect((await call("POST", "/invites/abc/join")).statusCode).toBe(401);
  });
});

describe("channels", () => {
  it("owner creates channels with increasing positions", async () => {
    const { owner, base } = await setup();
    const res = await call("POST", `${base}/channels`, owner, { name: "voice_1", type: "VOICE" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "voice_1", type: "VOICE", position: 1 });
  });

  it("409 on a duplicate name, 400 on a bad name", async () => {
    const { owner, base } = await setup();
    expect((await call("POST", `${base}/channels`, owner, { name: "general", type: "TEXT" })).statusCode).toBe(409);
    expect((await call("POST", `${base}/channels`, owner, { name: "Bad Name", type: "TEXT" })).statusCode).toBe(400);
  });

  it("members who are not the owner get 403 on create and delete", async () => {
    const { owner, other, base, general } = await setup();
    await join(other, (await invite(owner, base)).code);
    expect((await call("POST", `${base}/channels`, other, { name: "x", type: "TEXT" })).statusCode).toBe(403);
    expect((await call("DELETE", `${base}/channels/${general.id}`, other)).statusCode).toBe(403);
  });

  it("cannot delete the last channel; can delete another; wrong-guild id is 404", async () => {
    const { owner, other, base, general } = await setup();
    expect((await call("DELETE", `${base}/channels/${general.id}`, owner)).statusCode).toBe(409);
    const extra = (await call("POST", `${base}/channels`, owner, { name: "extra", type: "TEXT" })).json();
    expect((await call("DELETE", `${base}/channels/${extra.id}`, owner)).statusCode).toBe(204);

    const foreign = (await call("POST", "/guilds", other, { name: "Else" })).json();
    const url = `${base}/channels/${foreign.channels[0].id}`;
    expect((await call("DELETE", url, owner)).statusCode).toBe(404);
  });
});

describe("members", () => {
  it("lists userId, username, joinedAt, roleIds only", async () => {
    const { owner, base } = await setup();
    const res = await call("GET", `${base}/members`, owner);
    expect(res.json()).toEqual([{ userId: expect.any(String), username: "owner", joinedAt: expect.any(String), roleIds: [] }]);
    expect(res.body).not.toMatch(/email|passwordHash/);
  });

  it("owner cannot leave (409); a member can leave and then gets 404", async () => {
    const { owner, other, base } = await setup();
    await join(other, (await invite(owner, base)).code);
    expect((await call("DELETE", `${base}/members/me`, owner)).statusCode).toBe(409);
    expect((await call("DELETE", `${base}/members/me`, other)).statusCode).toBe(204);
    expect((await call("GET", base, other)).statusCode).toBe(404);
  });
});

describe("invites", () => {
  it("any member can create; join adds the member and counts a use", async () => {
    const { owner, other, third, base, guild } = await setup();
    const first = await invite(owner, base);
    expect(first.code).toMatch(/^[A-Za-z0-9_-]{8}$/);
    const res = await join(other, first.code);
    expect(res.statusCode).toBe(200);
    expect(res.json().guild.id).toBe(guild.id);
    expect(await uses(first.code)).toBe(1);
    expect((await call("POST", `${base}/invites`, other, {})).statusCode).toBe(201);
    expect((await call("POST", `${base}/invites`, third, {})).statusCode).toBe(404);
  });

  it("validates expiry and maxUses bounds", async () => {
    const { owner, base } = await setup();
    for (const body of [{ expiresInSeconds: 59 }, { expiresInSeconds: 31 * 86400 }, { maxUses: 0 }, { maxUses: 1001 }]) {
      expect((await call("POST", `${base}/invites`, owner, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await call("POST", `${base}/invites`, owner, { expiresInSeconds: 60, maxUses: 1000 })).statusCode).toBe(201);
  });

  it("a bodyless join with a json content-type header still works", async () => {
    const { owner, other, base } = await setup();
    const { code } = await invite(owner, base);
    const res = await app.inject({
      method: "POST",
      url: `/invites/${code}/join`,
      headers: { authorization: `Bearer ${other}`, "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("joining twice is 200 and burns no extra use", async () => {
    const { owner, other, base } = await setup();
    const { code } = await invite(owner, base, { maxUses: 5 });
    expect((await join(other, code)).statusCode).toBe(200);
    expect((await join(other, code)).statusCode).toBe(200);
    expect((await join(owner, code)).statusCode).toBe(200);
    expect(await uses(code)).toBe(1);
  });

  it("unknown, expired and used-up codes give the identical 404", async () => {
    const { owner, other, third, base } = await setup();
    const expired = await invite(owner, base);
    await prisma.invite.update({ where: { code: expired.code }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const single = await invite(owner, base, { maxUses: 1 });
    expect((await join(other, single.code)).statusCode).toBe(200);

    const unknown = await join(third, "nope1234");
    const exp = await join(third, expired.code);
    const used = await join(third, single.code);
    for (const res of [unknown, exp, used]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(unknown.body);
    }
    expect(await uses(single.code)).toBe(1);
    expect(await prisma.member.count({ where: { userId: (await prisma.user.findUniqueOrThrow({ where: { username: "third" } })).id } })).toBe(0);
  });

  it("concurrent joins with maxUses=1: exactly one succeeds", async () => {
    const { owner, base } = await setup();
    const joiners = await Promise.all(Array.from({ length: 6 }, (_, i) => signUp(`user${i}`)));
    const { code } = await invite(owner, base, { maxUses: 1 });
    const codes = (await Promise.all(joiners.map((t) => join(t, code)))).map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 404)).toHaveLength(5);
    expect(await uses(code)).toBe(1);
    expect(await prisma.member.count()).toBe(2);
  });

  it("the same user joining concurrently burns one use", async () => {
    const { owner, other, base } = await setup();
    const { code } = await invite(owner, base);
    const codes = (await Promise.all([join(other, code), join(other, code)])).map((r) => r.statusCode);
    expect(codes).toEqual([200, 200]);
    expect(await uses(code)).toBe(1);
  });
});
