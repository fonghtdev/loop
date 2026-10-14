import { readFileSync } from "node:fs";
import { LoopBot } from "@loop/bot-sdk";
import { attachWelcome, configSchema } from "./welcome.js";

const apiUrl = process.env.LOOP_API_URL;
const token = process.env.LOOP_BOT_TOKEN;
if (!apiUrl || !token) throw new Error("Set LOOP_API_URL and LOOP_BOT_TOKEN");

const config = configSchema.parse(JSON.parse(readFileSync(process.env.WELCOME_CONFIG ?? "./welcome.config.json", "utf8")));
const bot = new LoopBot({ apiUrl, token });
bot.on("error", (e) => console.error("[welcome]", e.message));
attachWelcome(bot, config);
await bot.start();
console.log("[welcome] ready");
process.on("SIGINT", () => bot.stop());
process.on("SIGTERM", () => bot.stop());
