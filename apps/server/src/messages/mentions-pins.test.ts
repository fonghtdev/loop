import { MAX_MENTIONS_PER_MESSAGE, MAX_PINS_PER_CONVERSATION, Permission as P } from "@loop/shared";
import { io, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, makeRole, resetDb, signUp as signUpUser } from "../../test/helpers.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
type U = Awaited<ReturnType<typeof signUp>>;
let port: number;
const sockets: Socket[] = [];

beforeAll(async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});
beforeEach(resetDb);
afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** owner + a member + a moderator (MANAGE_MESSAGES) in a guild with #general; `lurker` is a member who cannot see #secret. */
async function setup() {
  const [owner, member, mod, lurker, outsider] = await Promise.all(["owner", "member", "mod", "lurker", "outsider"].map(signUp));
  const { guild, channels } = (await call("POST", "/guilds", owner.token, { name: "HQ" })).json();
  const { code } = (await call("POST", `/guilds/${guild.id}/invites`, owner.token, {})).json();
  for (const u of [member, mod, lurker]) await call("POST", `/invites/${code}/join`, u.token);
  await makeRole(guild.id, 5, P.MANAGE_MESSAGES, [mod.id]);
  const secret = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "secret", type: "TEXT" })).json();
  await call("PUT", `/channels/${secret.id}/overwrites/${guild.id}`, owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
  return {
    owner, member, mod, lurker, outsider, guild,
    channel: channels[0],
    url: `/channels/${channels[0].id}/messages`,
    secretUrl: `/channels/${secret.id}/messages`,
  };
}
const send = (u: U, url: string, content: string) => call("POST", url, u.token, { content });
const tag = (u: { id: string }) => `<@${u.id}>`;
const history = async (u: U, url: string) => (await call("GET", url, u.token)).json().messages as any[];

describe("mentions", () => {
  it("keeps a member who can see the channel; the other tokens stay inert text", async () => {
    const { owner, member, lurker, outsider, secretUrl, url } = await setup();
    const ghost = "00000000-0000-4000-8000-000000000000";
    const res = await send(owner, secretUrl, `${tag(member)} ${tag(lurker)} ${tag(outsider)} <@${ghost}> <@nope>`);
    // @everyone is denied VIEW in #secret, so nobody mentioned can read it
    expect(res.json().mentions).toEqual([]);
    const ok = await send(owner, url, `hi ${tag(member)} and ${tag(lurker)}, not ${tag(outsider)} nor <@${ghost}>`);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().mentions).toEqual([member.id, lurker.id]);
    expect(ok.json().content).toContain(tag(outsider)); // the text is never rewritten
    expect((await history(member, url))[0].mentions).toEqual([member.id, lurker.id]);
  });

  it("needs VIEW on that channel, not just membership", async () => {
    const { owner, mod, lurker, secretUrl, guild } = await setup();
    const secretId = (await prisma.channel.findFirstOrThrow({ where: { guildId: guild.id, name: "secret" } })).id;
    const modRole = (await prisma.role.findFirstOrThrow({ where: { guildId: guild.id, position: 5 } })).id;
    await call("PUT", `/channels/${secretId}/overwrites/${modRole}`, owner.token, { allow: P.VIEW_CHANNEL, deny: 0 });
    expect((await send(owner, secretUrl, `${tag(mod)} ${tag(lurker)}`)).json().mentions).toEqual([mod.id]);
  });

  it("dedupes and caps at 20 distinct ids; a mention of yourself is kept", async () => {
    const { owner, member, url } = await setup();
    const res = await send(owner, url, `${tag(member)}${tag(member)} ${tag(owner)}`);
    expect(res.json().mentions).toEqual([member.id, owner.id]);
    const many = Array.from({ length: MAX_MENTIONS_PER_MESSAGE + 5 }, (_, i) => `<@00000000-0000-4000-8000-${String(i).padStart(12, "0")}>`);
    await send(owner, url, `${many.join("")}${tag(member)}`); // 25 unknown ids come first and use up the cap
    const row = await prisma.message.findFirstOrThrow({ orderBy: { seq: "desc" }, include: { mentions: true } });
    expect(row.mentions).toEqual([]);
  });

  it("an edit recomputes the mentions from the new text", async () => {
    const { owner, member, lurker, url } = await setup();
    const msg = (await send(owner, url, `${tag(member)}`)).json();
    const edited = await call("PATCH", `/messages/${msg.id}`, owner.token, { content: `${tag(lurker)} instead` });
    expect(edited.json().mentions).toEqual([lurker.id]);
    expect((await history(owner, url))[0].mentions).toEqual([lurker.id]);
    const cleared = await call("PATCH", `/messages/${msg.id}`, owner.token, { content: "nobody" });
    expect(cleared.json().mentions).toEqual([]);
    expect(await prisma.messageMention.count()).toBe(0);
  });

  it("@everyone and @here count only for an author with MENTION_EVERYONE", async () => {
    const { owner, member, mod, url, guild } = await setup();
    expect((await send(member, url, "@everyone look")).json().mentionEveryone).toBe(false);
    expect((await send(owner, url, "@everyone look")).json().mentionEveryone).toBe(true);
    expect((await send(owner, url, "ping @here")).json().mentionEveryone).toBe(true);
    expect((await send(owner, url, "mail me@everyone.com or @everyones")).json().mentionEveryone).toBe(false);
    expect((await send(owner, url, "plain")).json().mentionEveryone).toBe(false);
    await prisma.role.updateMany({ where: { guildId: guild.id, position: 5 }, data: { permissions: P.MANAGE_MESSAGES | P.MENTION_EVERYONE } });
    const msg = (await send(mod, url, "@here now")).json();
    expect(msg.mentionEveryone).toBe(true);
    // the bit is checked again on edit
    await prisma.role.updateMany({ where: { guildId: guild.id, position: 5 }, data: { permissions: P.MANAGE_MESSAGES } });
    expect((await call("PATCH", `/messages/${msg.id}`, mod.token, { content: "@here again" })).json().mentionEveryone).toBe(false);
    expect((await history(member, url)).map((m) => m.mentionEveryone)).toEqual([false, true, true, false, false, false]);
  });

  it("MENTION_EVERYONE can be granted per channel by an overwrite", async () => {
    const { owner, member, channel, url, guild } = await setup();
    await call("PUT", `/channels/${channel.id}/overwrites/${guild.id}`, owner.token, { allow: P.MENTION_EVERYONE, deny: 0 });
    expect((await send(member, url, "@everyone")).json().mentionEveryone).toBe(true);
  });

  it("in a DM only the two participants can be mentioned and @everyone is plain text", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await befriend(app, a, b);
    const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json();
    const res = await send(a, `/dms/${dm.id}/messages`, `${tag(b)} ${tag(c)} @everyone`);
    expect(res.json().mentions).toEqual([b.id]);
    expect(res.json().mentionEveryone).toBe(false);
  });

  it("pushes mention:new to the mentioned user's room only (never the author, never a bystander); @everyone reaches every viewer", async () => {
    const { owner, member, lurker, outsider, channel, url, guild } = await setup();
    const connect = async (u: U) => {
      const s = io(`http://127.0.0.1:${port}`, { auth: { token: u.token }, reconnection: false, forceNew: true });
      sockets.push(s);
      await new Promise<void>((resolve, reject) => (s.once("connect", resolve), s.once("connect_error", reject)));
      const got: any[] = [];
      s.on("mention:new", (p) => got.push(p)); // nobody subscribes to the channel room
      return Object.assign(s, { got });
    };
    const [o, m, l, x] = await Promise.all([connect(owner), connect(member), connect(lurker), connect(outsider)]);
    const msg = (await send(owner, url, `${tag(member)} ${tag(owner)}`)).json();
    await vi.waitFor(() => expect(m.got.length).toBe(1), { timeout: 2000 });
    expect(m.got[0]).toMatchObject({ guildId: guild.id, channelId: channel.id, message: { id: msg.id, mentions: [member.id, owner.id] } });
    await send(owner, url, "@everyone hello");
    await vi.waitFor(() => expect([m.got.length, l.got.length]).toEqual([2, 1]), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 100));
    expect([o.got, x.got]).toEqual([[], []]);
  });

  it("rides along on message:new and message:update", async () => {
    const { owner, member, channel, url } = await setup();
    const s = io(`http://127.0.0.1:${port}`, { auth: { token: member.token }, reconnection: false, forceNew: true });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => (s.once("connect", resolve), s.once("connect_error", reject)));
    await s.emitWithAck("channel:subscribe", { channelId: channel.id });
    const got: any[] = [];
    s.on("message:new", (m) => got.push(m));
    s.on("message:update", (m) => got.push(m));
    const msg = (await send(owner, url, tag(member))).json();
    await call("PATCH", `/messages/${msg.id}`, owner.token, { content: "no one" });
    await vi.waitFor(() => expect(got.map((m) => m.mentions)).toEqual([[member.id], []]), { timeout: 2000 });
  });
});

describe("pins", () => {
  it("a moderator pins and unpins; pinned shows in history and in the pins list, newest pin first", async () => {
    const { owner, member, mod, channel, url } = await setup();
    const [a, b] = [(await send(owner, url, "first")).json(), (await send(owner, url, "second")).json()];
    expect(a.pinned).toBe(false);
    expect((await call("PUT", `/messages/${a.id}/pin`, mod.token)).statusCode).toBe(204);
    expect((await call("PUT", `/messages/${b.id}/pin`, mod.token)).statusCode).toBe(204);
    expect((await call("PUT", `/messages/${a.id}/pin`, mod.token)).statusCode).toBe(204); // idempotent
    const pins = (await call("GET", `/channels/${channel.id}/pins`, member.token)).json().messages;
    expect(pins.map((m: any) => [m.content, m.pinned])).toEqual([["second", true], ["first", true]]);
    expect((await history(member, url)).map((m) => m.pinned)).toEqual([true, true]);
    expect((await call("DELETE", `/messages/${a.id}/pin`, mod.token)).statusCode).toBe(204);
    expect((await call("DELETE", `/messages/${a.id}/pin`, mod.token)).statusCode).toBe(204); // idempotent
    expect((await call("GET", `/channels/${channel.id}/pins`, member.token)).json().messages.map((m: any) => m.content)).toEqual(["second"]);
  });

  it("a plain member (even the author) cannot pin or unpin; an outsider sees nothing", async () => {
    const { owner, member, outsider, channel, url } = await setup();
    const msg = (await send(member, url, "mine")).json();
    expect((await call("PUT", `/messages/${msg.id}/pin`, member.token)).statusCode).toBe(403);
    await call("PUT", `/messages/${msg.id}/pin`, owner.token);
    expect((await call("DELETE", `/messages/${msg.id}/pin`, member.token)).statusCode).toBe(403);
    expect((await call("PUT", `/messages/${msg.id}/pin`, outsider.token)).statusCode).toBe(404);
    expect((await call("GET", `/channels/${channel.id}/pins`, outsider.token)).statusCode).toBe(404);
  });

  it("allows 50 per channel, then 409 `Pin limit reached`; unpinning makes room; re-pinning a pinned one stays 204", async () => {
    const { owner, channel } = await setup();
    const ids = (await Promise.all(Array.from({ length: MAX_PINS_PER_CONVERSATION + 1 }, (_, i) => prisma.message.create({ data: { channelId: channel.id, authorId: owner.id, content: `m${i}` }, select: { id: true } })))).map((m) => m.id);
    for (const id of ids.slice(0, MAX_PINS_PER_CONVERSATION)) expect((await call("PUT", `/messages/${id}/pin`, owner.token)).statusCode).toBe(204);
    const over = await call("PUT", `/messages/${ids[MAX_PINS_PER_CONVERSATION]}/pin`, owner.token);
    expect([over.statusCode, over.json().error]).toEqual([409, "Pin limit reached"]);
    expect((await call("PUT", `/messages/${ids[0]}/pin`, owner.token)).statusCode).toBe(204);
    await call("DELETE", `/messages/${ids[0]}/pin`, owner.token);
    expect((await call("PUT", `/messages/${ids[MAX_PINS_PER_CONVERSATION]}/pin`, owner.token)).statusCode).toBe(204);
  });

  it("the limit is per conversation: another channel still pins", async () => {
    const { owner, guild, channel } = await setup();
    const other = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "other", type: "TEXT" })).json();
    await prisma.message.createMany({ data: Array.from({ length: MAX_PINS_PER_CONVERSATION }, (_, i) => ({ channelId: channel.id, authorId: owner.id, content: `m${i}`, pinnedAt: new Date() })) });
    const msg = (await send(owner, `/channels/${other.id}/messages`, "x")).json();
    expect((await call("PUT", `/messages/${msg.id}/pin`, owner.token)).statusCode).toBe(204);
  });

  it("emits message:pin to the channel only on a real change", async () => {
    const { owner, mod, channel, outsider, url } = await setup();
    const connect = async (u: U) => {
      const s = io(`http://127.0.0.1:${port}`, { auth: { token: u.token }, reconnection: false, forceNew: true });
      sockets.push(s);
      await new Promise<void>((resolve, reject) => (s.once("connect", resolve), s.once("connect_error", reject)));
      const got: any[] = [];
      s.on("message:pin", (p) => got.push(p));
      return Object.assign(s, { got });
    };
    const [a, o] = await Promise.all([connect(owner), connect(outsider)]);
    await a.emitWithAck("channel:subscribe", { channelId: channel.id });
    const msg = (await send(owner, url, "x")).json();
    await call("PUT", `/messages/${msg.id}/pin`, mod.token);
    await call("PUT", `/messages/${msg.id}/pin`, mod.token);
    await call("DELETE", `/messages/${msg.id}/pin`, mod.token);
    await call("DELETE", `/messages/${msg.id}/pin`, mod.token);
    await vi.waitFor(() => expect(a.got.length).toBe(2), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(a.got).toEqual([
      { messageId: msg.id, channelId: channel.id, pinned: true },
      { messageId: msg.id, channelId: channel.id, pinned: false },
    ]);
    expect(o.got).toEqual([]);
  });

  describe("in a DM", () => {
    async function dmSetup() {
      const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
      await befriend(app, a, b);
      const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json();
      const msg = (await send(a, `/dms/${dm.id}/messages`, "keep this")).json();
      return { a, b, c, dm, msg };
    }

    it("either friend pins and unpins; the list is readable by both, not by a stranger", async () => {
      const { a, b, c, dm, msg } = await dmSetup();
      expect((await call("PUT", `/messages/${msg.id}/pin`, b.token)).statusCode).toBe(204);
      for (const u of [a, b]) expect((await call("GET", `/dms/${dm.id}/pins`, u.token)).json().messages.map((m: any) => [m.content, m.pinned])).toEqual([["keep this", true]]);
      expect((await call("GET", `/dms/${dm.id}/pins`, c.token)).statusCode).toBe(404);
      expect((await call("PUT", `/messages/${msg.id}/pin`, c.token)).statusCode).toBe(404);
      expect((await call("DELETE", `/messages/${msg.id}/pin`, a.token)).statusCode).toBe(204);
      expect((await call("GET", `/dms/${dm.id}/pins`, a.token)).json().messages).toEqual([]);
    });

    it("pinning needs a live friendship; unpinning and reading do not", async () => {
      const { a, b, dm, msg } = await dmSetup();
      await call("PUT", `/messages/${msg.id}/pin`, a.token);
      await call("DELETE", `/friends/${b.id}`, a.token);
      const second = await prisma.message.create({ data: { dmChannelId: dm.id, authorId: a.id, content: "later" } });
      const res = await call("PUT", `/messages/${second.id}/pin`, a.token);
      expect([res.statusCode, res.json().error]).toEqual([403, "Not friends"]);
      expect((await call("GET", `/dms/${dm.id}/pins`, b.token)).statusCode).toBe(200);
      expect((await call("DELETE", `/messages/${msg.id}/pin`, b.token)).statusCode).toBe(204);
    });

    it("emits dm:message:pin to both people and nobody else", async () => {
      const { a, b, c, msg } = await dmSetup();
      const got: Record<string, any[]> = { a: [], b: [], c: [] };
      for (const [key, u] of [["a", a], ["b", b], ["c", c]] as const) {
        const s = io(`http://127.0.0.1:${port}`, { auth: { token: u.token }, reconnection: false, forceNew: true });
        sockets.push(s);
        await new Promise<void>((resolve, reject) => (s.once("connect", resolve), s.once("connect_error", reject)));
        s.on("dm:message:pin", (p) => got[key]!.push(p));
      }
      await call("PUT", `/messages/${msg.id}/pin`, a.token);
      await vi.waitFor(() => expect([got.a!.length, got.b!.length]).toEqual([1, 1]), { timeout: 2000 });
      await new Promise((r) => setTimeout(r, 100));
      expect(got.a![0]).toMatchObject({ messageId: msg.id, pinned: true });
      expect(got.c).toEqual([]);
    });

    it("the 50 limit applies to a DM too", async () => {
      const { a, dm, msg } = await dmSetup();
      await prisma.message.createMany({ data: Array.from({ length: MAX_PINS_PER_CONVERSATION }, (_, i) => ({ dmChannelId: dm.id, authorId: a.id, content: `p${i}`, pinnedAt: new Date() })) });
      expect((await call("PUT", `/messages/${msg.id}/pin`, a.token)).statusCode).toBe(409);
    });
  });
});
