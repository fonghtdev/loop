import { LoopBot } from "@loop/bot-sdk";
import { attachMusic } from "./music.js";
import { createSource } from "./source.js";

const apiUrl = process.env.LOOP_API_URL;
const token = process.env.LOOP_BOT_TOKEN;
if (!apiUrl || !token) throw new Error("Set LOOP_API_URL and LOOP_BOT_TOKEN");

const bot = new LoopBot({ apiUrl, token });
bot.on("error", (e) => console.error("[music]", e.message));
attachMusic(bot, createSource({ ytdlp: process.env.YTDLP_PATH, ffmpeg: process.env.FFMPEG_PATH }));
await bot.start();
console.log("[music] ready");
process.on("SIGINT", () => bot.stop());
process.on("SIGTERM", () => bot.stop());
