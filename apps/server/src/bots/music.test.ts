import { LoopBot } from "@loop/bot-sdk";
import { attachMusic } from "@loop/bot-music/music.js";
import { AudioStream, RoomEvent, TrackKind, type Room } from "@livekit/rtc-node";
import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, resetDb, signUp } from "../../test/helpers.js";
import { connect, listen, settle, until } from "../../test/sockets.js";
import { addVoiceChannel, disconnectAll, eventually, expectInRoom, identities, joinAs, requestToken } from "../../test/voice.js";
import { voiceRoom } from "../voice/rooms.js";

// The music bot against the real server and LiveKit, with a generated sine instead of yt-dlp/ffmpeg.
const app = buildApp(env);
const call = caller(app);
let port = 0;
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

function listenRms(room: Room) {
  const log: { at: number; rms: number }[] = [];
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    void (async () => {
      for await (const frame of new AudioStream(track, 48000, 1)) {
        log.push({ at: Date.now(), rms: Math.sqrt(frame.data.reduce((acc, v) => acc + v * v, 0) / frame.data.length) });
      }
    })().catch(() => {});
  });
  return log;
}

/** Sine of amplitude 8000 in 20 ms chunks until the signal aborts (or `seconds` pass). */
async function* sine(seconds: number, signal: AbortSignal) {
  for (let c = 0; c < seconds * 50 && !signal.aborted; c++) {
    const chunk = new Int16Array(960);
    for (let i = 0; i < 960; i++) chunk[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (c * 960 + i)) / 48000));
    yield Buffer.from(chunk.buffer);
  }
}

async function setup() {
  const owner = await signUp(app, "owner");
  const listener = await signUp(app, "listener");
  const { guild, general } = await guildWith(app, owner, listener);
  const voice = await addVoiceChannel(app, owner, guild.id);
  const { bot: botUser, token } = (await call("POST", "/bots", owner.token, { name: "dj_bot" })).json();
  const { accessToken } = (await call("POST", "/auth/bot-login", undefined, { token })).json();
  const { code } = (await call("POST", `/guilds/${guild.id}/invites`, owner.token, {})).json();
  await call("POST", `/invites/${code}/join`, accessToken);

  const opened: string[] = [];
  const aborted: string[] = [];
  const source = {
    resolve: async (query: string) => ({ id: query, title: `title ${query}`, duration: 60 }),
    open: (t: { id: string }, signal: AbortSignal) => {
      opened.push(t.id);
      signal.addEventListener("abort", () => aborted.push(t.id));
      return sine(30, signal);
    },
  };
  const bot = new LoopBot({ apiUrl: `http://127.0.0.1:${port}`, token });
  bot.on("error", () => {});
  bots.push(bot);
  attachMusic(bot, source);
  await bot.start();

  const feed = await connect(port, listener.token, ["message:new"], sockets);
  await feed.emitWithAck("channel:subscribe", { channelId: general.id });
  const replies = () => feed.got["message:new"]!.filter((m) => m.author.username === "dj_bot").map((m) => m.content as string);
  const say = (user: { token: string }, content: string) => call("POST", `/channels/${general.id}/messages`, user.token, { content });
  const room = await joinAs((await requestToken(app, listener, voice.id)).json());
  return { owner, listener, guild, general, voice, botId: botUser.id as string, say, replies, opened, aborted, log: listenRms(room) };
}
const loud = (log: { at: number; rms: number }[], since = 0) => log.filter((f) => f.at >= since && f.rms > 2000);

describe("music bot", () => {
  it("!play joins the caller's voice channel and the listener hears it; !skip moves on; !stop leaves and cleans up", { timeout: 30_000 }, async () => {
    const { listener, voice, botId, say, replies, opened, aborted, log } = await setup();

    await say(listener, "!play one");
    await expectInRoom(voiceRoom(voice.id), [listener.id, botId]);
    await eventually(() => expect(loud(log).length).toBeGreaterThan(20));
    expect(replies()).toEqual(["Đang phát: title one"]);

    await say(listener, "!play two");
    await until(() => replies().includes("Đã thêm vào hàng đợi (vị trí 1): title two"));
    await say(listener, "!queue");
    await until(() => replies().some((r) => r.startsWith("Đang phát: title one\n1. title two")));

    await say(listener, "!skip");
    await until(() => opened.includes("two"));
    expect(aborted).toContain("one");
    const t = Date.now();
    await eventually(() => expect(loud(log, t).length).toBeGreaterThan(20)); // the second track is audible

    await say(listener, "!stop");
    await eventually(async () => expect(await identities(voiceRoom(voice.id))).toEqual([listener.id]));
    expect(aborted).toContain("two");
    await say(listener, "!stop");
    await until(() => replies().at(-1) === "Mình không ở kênh thoại nào.");
  });

  it("asks for a voice channel first; ignores other bots, plain chat and an empty !play", async () => {
    const { owner, listener, voice, say, replies } = await setup();
    await say(owner, "!play x"); // owner is in no voice channel
    await until(() => replies().length === 1);
    expect(replies()).toEqual(["Bạn cần vào một kênh thoại trước."]);

    await say(owner, "hello !play x");
    await say(listener, "!play");
    await until(() => replies().length === 2);
    expect(replies()[1]).toMatch(/^Dùng: !play/);
    await settle();
    expect(replies()).toHaveLength(2);
    expect(await identities(voiceRoom(voice.id))).toEqual([listener.id]);
  });

  it("ignores commands typed by another bot", async () => {
    const { owner, listener, guild, general, voice, replies } = await setup();
    const other = (await call("POST", "/bots", owner.token, { name: "other_bot" })).json();
    const { accessToken } = (await call("POST", "/auth/bot-login", undefined, { token: other.token })).json();
    const { code } = (await call("POST", `/guilds/${guild.id}/invites`, owner.token, {})).json();
    await call("POST", `/invites/${code}/join`, accessToken);
    await call("POST", `/channels/${general.id}/messages`, accessToken, { content: "!play x" });
    await settle();
    expect(replies()).toEqual([]);
    expect(await identities(voiceRoom(voice.id))).toEqual([listener.id]);
  });
});
