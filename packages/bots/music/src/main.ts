import { chmodSync, copyFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopBot } from "@loop/bot-sdk";
import { attachMusic } from "./music.js";
import { createSource, parseSources } from "./source.js";

const apiUrl = process.env.LOOP_API_URL;
const token = process.env.LOOP_BOT_TOKEN;
if (!apiUrl || !token) throw new Error("Set LOOP_API_URL and LOOP_BOT_TOKEN");

const bot = new LoopBot({ apiUrl, token });
bot.on("error", (e) => console.error("[music]", e.message));
// Optional YouTube cookies (a hosted bot is usually refused as "not a bot"). yt-dlp rewrites its cookie file when it exits and a
// platform secret file is read-only, so it gets a private writable copy.
function cookieCopy() {
  const from = process.env.YTDLP_COOKIES;
  if (!from) return undefined;
  try {
    const to = join(mkdtempSync(join(tmpdir(), "loop-music-")), "cookies.txt");
    copyFileSync(from, to);
    chmodSync(to, 0o600);
    return to;
  } catch (e) {
    console.error("[music] cannot use YTDLP_COOKIES, continuing without:", (e as Error).message);
    return undefined;
  }
}
attachMusic(
  bot,
  createSource({ ytdlp: process.env.YTDLP_PATH, ffmpeg: process.env.FFMPEG_PATH, cookies: cookieCopy(), ytClient: process.env.YTDLP_YT_CLIENT, sources: parseSources(process.env.MUSIC_SOURCES) }),
);
// Hosts that only run web services (Render free) need a port to answer on, and an uptime pinger hitting it keeps the bot awake.
const port = process.env.PORT;
const health = port ? createServer((_req, res) => res.end("ok")).listen(Number(port)) : undefined;
// The Loop server may be asleep (free hosting): the first login wakes it, so retry instead of crashing.
for (;;) {
  try {
    await bot.start();
    break;
  } catch (e) {
    console.error("[music] start failed, retrying in 15s:", (e as Error).message);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}
console.log("[music] ready");
// What the bot can see, so a silent bot can be told apart from a bot that is not in the right place.
const describe = async () => {
  for (const g of await bot.listGuilds()) {
    const channels = await bot.listChannels(g.id);
    console.log(`[music] guild "${g.name}": ${channels.map((c) => `${c.type}:${c.name}`).join(", ")}`);
  }
};
bot.on("ready", () => void describe().catch((e) => console.error("[music]", e.message)));
bot.on("message", (m) => console.log(`[music] message in ${m.channelId} from ${m.author.username}: ${m.content.slice(0, 40)}`));
void describe().catch((e) => console.error("[music]", e.message));
const shutdown = () => {
  health?.close();
  bot.stop();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
