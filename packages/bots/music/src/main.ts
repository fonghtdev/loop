import { createServer } from "node:http";
import { LoopBot } from "@loop/bot-sdk";
import { attachMusic } from "./music.js";
import { createSource } from "./source.js";

const apiUrl = process.env.LOOP_API_URL;
const token = process.env.LOOP_BOT_TOKEN;
if (!apiUrl || !token) throw new Error("Set LOOP_API_URL and LOOP_BOT_TOKEN");

const bot = new LoopBot({ apiUrl, token });
bot.on("error", (e) => console.error("[music]", e.message));
attachMusic(bot, createSource({ ytdlp: process.env.YTDLP_PATH, ffmpeg: process.env.FFMPEG_PATH }));
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
const shutdown = () => {
  health?.close();
  bot.stop();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
