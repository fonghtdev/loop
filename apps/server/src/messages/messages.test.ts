import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, resetDb, signUp as signUpUser } from "../../test/helpers.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);

async function setup() {
  const [owner, member, outsider] = await Promise.all([signUp("owner"), signUp("member"), signUp("outsider")]);
  const { guild, channels } = (await call("POST", "/guilds", owner.token, { name: "HQ" })).json();
  const code = (await call("POST", `/guilds/${guild.id}/invites`, owner.token, {})).json().code;
  await call("POST", `/invites/${code}/join`, member.token);
  const voice = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "talk", type: "VOICE" })).json();
  return { owner, member, outsider, guild, channel: channels[0], voice, url: `/channels/${channels[0].id}/messages` };
}
const send = async (token: string, url: string, content: string) => (await call("POST", url, token, { content })).json();
const history = async (token: string, url: string, query = "") =>
  (await call("GET", `${url}${query}`, token)).json().messages as { id: string; seq: string; content: string }[];

beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("send", () => {
  it("a member sends; author is id + username only", async () => {
    const { member, url, channel } = await setup();
    const res = await call("POST", url, member.token, { content: "  hello  " });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg).toMatchObject({ channelId: channel.id, content: "hello", editedAt: null, author: { id: member.id, username: "member" } });
    expect(Object.keys(msg.author).sort()).toEqual(["id", "username"]);
    expect(typeof msg.seq).toBe("string");
  });

  it("404 for a non-member, an unknown id and a malformed id", async () => {
    const { outsider, url } = await setup();
    const unknown = "/channels/00000000-0000-4000-8000-000000000000/messages";
    for (const u of [url, unknown, "/channels/nope/messages"]) {
      expect((await call("POST", u, outsider.token, { content: "x" })).statusCode).toBe(404);
      expect((await call("GET", u, outsider.token)).statusCode).toBe(404);
    }
  });

  it("400 on a voice channel", async () => {
    const { owner, voice } = await setup();
    expect((await call("POST", `/channels/${voice.id}/messages`, owner.token, { content: "x" })).statusCode).toBe(400);
  });

  it("content must be 1..2000 chars after trim", async () => {
    const { owner, url } = await setup();
    const status = async (content: unknown) => (await call("POST", url, owner.token, { content } as object)).statusCode;
    expect(await status("")).toBe(400);
    expect(await status("   ")).toBe(400);
    expect(await status(undefined)).toBe(400);
    expect(await status("a".repeat(2001))).toBe(400);
    expect(await status("bad\0byte")).toBe(400);
    expect(await status("a".repeat(2000))).toBe(201);
    expect(await status(` ${"a".repeat(2000)} `)).toBe(201);
  });

  it("401 without a token", async () => {
    const { url } = await setup();
    expect((await call("POST", url, undefined, { content: "x" })).statusCode).toBe(401);
    expect((await call("GET", url)).statusCode).toBe(401);
    expect((await call("PATCH", "/messages/x", undefined, { content: "x" })).statusCode).toBe(401);
    expect((await call("DELETE", "/messages/x")).statusCode).toBe(401);
  });
});

describe("history", () => {
  async function seed(count: number, setupData: Awaited<ReturnType<typeof setup>>) {
    const createdAt = new Date(); // identical on purpose: only seq may order them
    await prisma.message.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        channelId: setupData.channel.id,
        authorId: setupData.owner.id,
        content: `m${i}`,
        createdAt,
      })),
    });
  }

  it("default is the newest 50, ascending", async () => {
    const s = await setup();
    await seed(60, s);
    const msgs = await history(s.owner.token, s.url);
    expect(msgs.map((m) => m.content)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i + 10}`));
  });

  it("walking back with `before` returns every message once, in order", async () => {
    const s = await setup();
    await seed(120, s);
    const walked: string[] = [];
    let page = await history(s.owner.token, s.url);
    while (page.length) {
      walked.unshift(...page.map((m) => m.content));
      page = await history(s.owner.token, s.url, `?before=${page[0]!.seq}`);
    }
    expect(walked).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`));
  });

  it("`after` returns only newer messages, ascending, and pages forward", async () => {
    const s = await setup();
    await seed(10, s);
    const all = await history(s.owner.token, s.url);
    const newer = await history(s.owner.token, s.url, `?after=${all[6]!.seq}`);
    expect(newer.map((m) => m.content)).toEqual(["m7", "m8", "m9"]);
    const page = await history(s.owner.token, s.url, `?after=${all[0]!.seq}&limit=2`);
    expect(page.map((m) => m.content)).toEqual(["m1", "m2"]);
  });

  it("400 on before+after, bad cursors and out-of-range limits; limit 1 and 100 are fine", async () => {
    const s = await setup();
    const status = async (q: string) => (await call("GET", `${s.url}${q}`, s.owner.token)).statusCode;
    expect(await status("?before=5&after=1")).toBe(400);
    expect(await status("?before=abc")).toBe(400);
    expect(await status("?before=-1")).toBe(400);
    expect(await status("?limit=0")).toBe(400);
    expect(await status("?limit=101")).toBe(400);
    expect(await status("?limit=1")).toBe(200);
    expect(await status("?limit=100")).toBe(200);
  });

  it("messages sent concurrently get distinct, increasing seq and the same order in history", async () => {
    const s = await setup();
    const sent = await Promise.all(Array.from({ length: 20 }, (_, i) => send(s.owner.token, s.url, `c${i}`)));
    const seqs = (await history(s.owner.token, s.url)).map((m) => BigInt(m.seq));
    expect(new Set(seqs).size).toBe(sent.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => (a < b ? -1 : 1)));
  });

  it("only returns this channel's messages", async () => {
    const s = await setup();
    const other = (await call("POST", `/guilds/${s.guild.id}/channels`, s.owner.token, { name: "other", type: "TEXT" })).json();
    await send(s.owner.token, s.url, "here");
    await send(s.owner.token, `/channels/${other.id}/messages`, "there");
    expect((await history(s.owner.token, s.url)).map((m) => m.content)).toEqual(["here"]);
  });
});

describe("edit and delete", () => {
  it("author edits and editedAt is set; another member gets 403; a non-member 404", async () => {
    const { owner, member, outsider, url } = await setup();
    const msg = await send(member.token, url, "first");
    const res = await call("PATCH", `/messages/${msg.id}`, member.token, { content: "second" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: msg.id, content: "second", seq: msg.seq });
    expect(res.json().editedAt).not.toBeNull();
    expect((await call("PATCH", `/messages/${msg.id}`, owner.token, { content: "hijack" })).statusCode).toBe(403);
    expect((await call("PATCH", `/messages/${msg.id}`, outsider.token, { content: "x" })).statusCode).toBe(404);
    expect((await call("PATCH", `/messages/${msg.id}`, member.token, { content: " " })).statusCode).toBe(400);
    expect((await call("PATCH", "/messages/nope", member.token, { content: "x" })).statusCode).toBe(404);
    expect((await history(member.token, url))[0]!.content).toBe("second");
  });

  it("author and guild owner delete; another member gets 403; a non-member 404", async () => {
    const { owner, member, outsider, url } = await setup();
    const mine = await send(member.token, url, "a");
    const theirs = await send(owner.token, url, "b");
    const third = await send(member.token, url, "c");
    expect((await call("DELETE", `/messages/${theirs.id}`, member.token)).statusCode).toBe(403);
    expect((await call("DELETE", `/messages/${mine.id}`, outsider.token)).statusCode).toBe(404);
    expect((await call("DELETE", `/messages/${mine.id}`, member.token)).statusCode).toBe(204);
    expect((await call("DELETE", `/messages/${third.id}`, owner.token)).statusCode).toBe(204);
    expect((await call("DELETE", `/messages/${mine.id}`, member.token)).statusCode).toBe(404);
    expect((await history(owner.token, url)).map((m) => m.content)).toEqual(["b"]);
  });

  it("deleting a guild with messages still works (cascade)", async () => {
    const { owner, guild, url } = await setup();
    await send(owner.token, url, "bye");
    expect((await call("DELETE", `/guilds/${guild.id}`, owner.token)).statusCode).toBe(204);
    expect(await prisma.message.count()).toBe(0);
  });
});
