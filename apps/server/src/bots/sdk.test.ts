import { DEFAULT_EVERYONE_PERMISSIONS, Permission } from "@loop/shared";
import { ApiError, LoopBot } from "@loop/bot-sdk";
import { attachWelcome } from "@loop/bot-welcome";
import { AudioStream, Room, RoomEvent, TrackKind } from "@livekit/rtc-node";
import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, makeRole, resetDb, setEveryone, signUp } from "../../test/helpers.js";
import { connect, listen, settle, until } from "../../test/sockets.js";
import { addVoiceChannel, disconnectAll, eventually, expectInRoom, identities, joinAs, requestToken } from "../../test/voice.js";
import { voiceRoom } from "../voice/rooms.js";

const app = buildApp(env);
const call = caller(app);
let port = 0;
const apiUrl = () => `http://127.0.0.1:${port}`;

const sockets: Socket[] = [];
const bots: LoopBot[] = [];
beforeAll(async () => {
  port = await listen(app);
});
beforeEach(resetDb);
afterEach(async () => {
  bots.splice(0).forEach((b) => b.stop());
  await disconnectAll();
  sockets.splice(0).forEach((s) => s.close());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** A bot account of `owner`, joined to the guild by invite, not started. */
async function botIn(owner: { token: string }, guildId: string, name = "helper_bot") {
  const { bot, token } = (await call("POST", "/bots", owner.token, { name })).json();
  const { accessToken } = (await call("POST", "/auth/bot-login", undefined, { token })).json();
  const { code } = (await call("POST", `/guilds/${guildId}/invites`, owner.token, {})).json();
  await call("POST", `/invites/${code}/join`, accessToken);
  return { id: bot.id as string, instance: new LoopBot({ apiUrl: apiUrl(), token }) };
}
const startBot = async (instance: LoopBot) => {
  bots.push(instance);
  instance.on("error", () => {}); // reconnect tests provoke errors on purpose
  await instance.start();
};
/** A person's socket, subscribed to the channel, recording `message:new`. */
async function watch(user: { token: string }, channelId: string) {
  const s = await connect(port, user.token, ["message:new"], sockets);
  expect((await s.emitWithAck("channel:subscribe", { channelId })).ok).toBe(true);
  return s;
}
const texts = (s: { got: Record<string, any[]> }) => s.got["message:new"]!.map((m) => m.content);

describe("text", () => {
  it("receives people's messages (not its own) and its messages reach people", async () => {
    const owner = await signUp(app, "owner");
    const { guild, general } = await guildWith(app, owner);
    const { instance: bot } = await botIn(owner, guild.id);
    const got: string[] = [];
    bot.on("message", (m) => got.push(`${m.author.username}:${m.content}`));
    await startBot(bot);
    const person = await watch(owner, general.id);

    await call("POST", `/channels/${general.id}/messages`, owner.token, { content: "hello bot" });
    await until(() => got.length === 1);
    expect(got).toEqual(["owner:hello bot"]);

    const sent = await bot.sendMessage(general.id, "hello human");
    expect(sent).toMatchObject({ content: "hello human", author: { username: "helper_bot", isBot: true } });
    await until(() => texts(person).includes("hello human"));
    await settle();
    expect(got).toEqual(["owner:hello bot"]); // its own message was not emitted
  });

  it("lists guilds and channels, and rejects with a typed error", async () => {
    const owner = await signUp(app, "owner");
    const { guild, general } = await guildWith(app, owner);
    const { instance: bot } = await botIn(owner, guild.id);
    expect((await bot.listGuilds()).map((g) => g.id)).toEqual([guild.id]);
    expect((await bot.listChannels(guild.id)).map((c) => c.id)).toEqual([general.id]);
    const err = await bot.sendMessage("00000000-0000-4000-8000-000000000000", "x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });

  it("start() rejects on a wrong bot token", async () => {
    const bot = new LoopBot({ apiUrl: apiUrl(), token: "nope" });
    await expect(bot.start()).rejects.toMatchObject({ status: 401 });
  });

  it("logs in again by itself when a REST call finds the access token dead", async () => {
    const owner = await signUp(app, "owner");
    const { guild, general } = await guildWith(app, owner);
    const { instance: bot } = await botIn(owner, guild.id);
    await startBot(bot);
    (bot as any).api.accessToken = "expired";
    expect((await bot.sendMessage(general.id, "after relogin")).content).toBe("after relogin");
  });

  it("reconnects with a fresh login when the socket drops and the access token is dead", { timeout: 15_000 }, async () => {
    const owner = await signUp(app, "owner");
    const { guild, general } = await guildWith(app, owner);
    const { instance: bot } = await botIn(owner, guild.id);
    const got: string[] = [];
    bot.on("message", (m) => got.push(m.content));
    await startBot(bot);
    (bot as any).api.accessToken = "expired";
    const readyAgain = new Promise((resolve) => bot.once("ready", resolve));
    (bot as any).socket.io.engine.close(); // network drop
    await readyAgain;
    await call("POST", `/channels/${general.id}/messages`, owner.token, { content: "back again" });
    await until(() => got.includes("back again"));
  });
});

describe("memberJoin and the welcome bot", () => {
  const welcomeConfig = (guildId: string, channelId?: string) => ({
    default: { message: "Welcome {user} to {guild}!" },
    guilds: channelId ? { [guildId]: { channelId } } : {},
  });

  it("emits memberJoin for a person who joins by invite", async () => {
    const owner = await signUp(app, "owner");
    const { guild } = await guildWith(app, owner);
    const { instance: bot } = await botIn(owner, guild.id);
    const joins: unknown[] = [];
    bot.on("memberJoin", (e) => joins.push(e));
    await startBot(bot);
    const newcomer = await signUp(app, "newcomer");
    const { code } = (await call("POST", `/guilds/${guild.id}/invites`, owner.token, {})).json();
    await call("POST", `/invites/${code}/join`, newcomer.token);
    await until(() => joins.length === 1);
    expect(joins).toEqual([{ guildId: guild.id, user: { id: newcomer.id, username: "newcomer", isBot: false, displayName: null, avatarHash: null } }]);
    await call("POST", `/invites/${code}/join`, newcomer.token); // joining again is no news
    await settle();
    expect(joins).toHaveLength(1);
  });

  it("greets in the configured channel, falls back to the first text channel, skips bots", async () => {
    const owner = await signUp(app, "owner");
    const { guild, general } = await guildWith(app, owner);
    const lobby = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "lobby", type: "TEXT", categoryId: general.categoryId })).json();
    const { instance: bot } = await botIn(owner, guild.id);
    attachWelcome(bot, welcomeConfig(guild.id, lobby.id));
    await startBot(bot);
    const inGeneral = await watch(owner, general.id);
    const inLobby = await watch(owner, lobby.id);
    const { code } = (await call("POST", `/guilds/${guild.id}/invites`, owner.token, {})).json();

    await call("POST", `/invites/${code}/join`, (await signUp(app, "ann")).token);
    await until(() => texts(inLobby).length === 1);
    expect(texts(inLobby)).toEqual(["Welcome ann to HQ!"]);

    // a bot joining is not greeted
    const otherBot = (await call("POST", "/bots", owner.token, { name: "other_bot" })).json();
    const { accessToken } = (await call("POST", "/auth/bot-login", undefined, { token: otherBot.token })).json();
    await call("POST", `/invites/${code}/join`, accessToken);
    await settle();
    expect(texts(inLobby)).toHaveLength(1);

    // no configuration for the guild: the first text channel
    bot.stop();
    const second = new LoopBot({ apiUrl: apiUrl(), token: (bot as any).api.botToken });
    attachWelcome(second, welcomeConfig(guild.id));
    await startBot(second);
    await call("POST", `/invites/${code}/join`, (await signUp(app, "bob")).token);
    await until(() => texts(inGeneral).length === 1);
    expect(texts(inGeneral)).toEqual(["Welcome bob to HQ!"]);
  });

  it("tries the next channel when the bot may not post in the first", async () => {
    const owner = await signUp(app, "owner");
    const { guild, general } = await guildWith(app, owner);
    const second = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "second", type: "TEXT", categoryId: general.categoryId })).json();
    // the bot cannot SEND in #general
    const { instance: bot, id } = await botIn(owner, guild.id);
    const role = await makeRole(guild.id, 1, 0, [id]);
    await prisma.channelOverwrite.create({ data: { guildId: guild.id, channelId: general.id, roleId: role.id, allow: 0, deny: Permission.SEND_MESSAGES } });
    attachWelcome(bot, welcomeConfig(guild.id));
    await startBot(bot);
    const inSecond = await watch(owner, second.id);
    const { code } = (await call("POST", `/guilds/${guild.id}/invites`, owner.token, {})).json();
    await call("POST", `/invites/${code}/join`, (await signUp(app, "cy")).token);
    await until(() => texts(inSecond).length === 1);
  });
});

/** RMS of each 10 ms frame the room's first remote audio track delivers, with the time it arrived. */
function listenRms(room: Room) {
  const log: { at: number; rms: number }[] = [];
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    void (async () => {
      for await (const frame of new AudioStream(track, 48000, 1)) {
        const sum = frame.data.reduce((acc, v) => acc + v * v, 0);
        log.push({ at: Date.now(), rms: Math.sqrt(sum / frame.data.length) });
      }
    })().catch(() => {});
  });
  return log;
}

/** `seconds` of a 440 Hz sine at amplitude 8000, in 20 ms little-endian chunks. */
async function* sine(seconds: number) {
  const perChunk = 960;
  for (let c = 0; c < (seconds * 50); c++) {
    const chunk = new Int16Array(perChunk);
    for (let i = 0; i < perChunk; i++) chunk[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (c * perChunk + i)) / 48000));
    yield chunk;
  }
}

describe("voice", () => {
  async function setup() {
    const owner = await signUp(app, "owner");
    const listener = await signUp(app, "listener");
    const { guild } = await guildWith(app, owner, listener);
    const voice = await addVoiceChannel(app, owner, guild.id);
    const { instance: bot, id } = await botIn(owner, guild.id);
    await startBot(bot);
    const room = await joinAs((await requestToken(app, listener, voice.id)).json());
    return { owner, listener, guild, voice, bot, id, room, log: listenRms(room) };
  }
  const loud = (log: { at: number; rms: number }[], since = 0) => log.filter((f) => f.at >= since && f.rms > 2000);

  it("plays a sine the other participant hears, paced in real time; stop() cuts it; leave() leaves", async () => {
    const { bot, voice, id, listener, log } = await setup();
    const conn = await bot.joinVoice(voice.id);
    await expectInRoom(voiceRoom(voice.id), [listener.id, id]);
    await settle();
    expect(loud(log)).toHaveLength(0); // silent until it plays

    let peakQueue = 0;
    const watcher = setInterval(() => (peakQueue = Math.max(peakQueue, (conn as any).source.queuedDuration)), 10);
    const finished = await conn.playPcm(sine(1.5)).then(() => Date.now());
    clearInterval(watcher);
    expect(loud(log).length).toBeGreaterThan(30); // at least 300 ms of the tone arrived
    expect(peakQueue).toBeLessThan(450); // frames were not dumped into the native buffer ahead of time
    expect(finished - loud(log)[0]!.at).toBeGreaterThan(1000);

    // a long clip, cut in the middle
    const playing = conn.playPcm(sine(30));
    await eventually(() => expect(loud(log, Date.now() - 300).length).toBeGreaterThan(5));
    const t0 = Date.now();
    const clear = vi.spyOn((conn as any).source, "clearQueue"); // frames already queued natively must be dropped too
    conn.stop();
    expect(clear).toHaveBeenCalled();
    await playing;
    expect(Date.now() - t0).toBeLessThan(500);
    await new Promise((r) => setTimeout(r, 700));
    const stoppedAt = Date.now();
    await new Promise((r) => setTimeout(r, 500));
    expect(loud(log, stoppedAt)).toHaveLength(0);

    await conn.leave();
    await eventually(async () => expect(await identities(voiceRoom(voice.id))).toEqual([listener.id]));
  });

  it("a new playPcm replaces the one before; accepts Buffers of any length", async () => {
    const { bot, voice, log } = await setup();
    const conn = await bot.joinVoice(voice.id);
    const first = conn.playPcm(sine(30));
    const bytes = Buffer.from([...(await collect(sine(0.5)))]);
    const odd = (async function* () {
      for (let i = 0; i < bytes.length; i += 1001) yield bytes.subarray(i, i + 1001);
    })();
    await conn.playPcm(odd);
    await first; // replaced, so it ended early without error
    expect(loud(log).length).toBeGreaterThan(20);
    await conn.leave();
  });

  it("refuses without SPEAK, with a clear error", async () => {
    const { bot, voice, guild } = await setup();
    await setEveryone(guild.id, DEFAULT_EVERYONE_PERMISSIONS & ~Permission.SPEAK);
    const err = await bot.joinVoice(voice.id).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, message: expect.stringContaining("SPEAK") });
  });
});

async function collect(chunks: AsyncIterable<Int16Array>) {
  const out: number[] = [];
  for await (const c of chunks) out.push(...new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
  return out;
}
