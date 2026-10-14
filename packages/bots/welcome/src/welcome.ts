import type { Channel } from "@loop/shared";
import type { LoopBot } from "@loop/bot-sdk";
import { z } from "zod";

export const configSchema = z.object({
  default: z.object({ message: z.string().min(1).max(2000) }),
  guilds: z.record(z.object({ channelId: z.string().optional(), message: z.string().min(1).max(2000).optional() })).default({}),
});
export type WelcomeConfig = z.infer<typeof configSchema>;

/** `{user}` and `{guild}` are replaced in one pass, so a name that itself contains `{guild}` stays as typed. */
export function buildMessage(template: string, vars: { user: string; guild: string }) {
  return template.replace(/\{(user|guild)\}/g, (_, key: "user" | "guild") => vars[key]);
}

/** Text channels to try, best first: the configured one alone, else all in the order given (display order). */
export function candidateChannels(channels: Channel[], channelId?: string) {
  const text = channels.filter((c) => c.type === "TEXT");
  return channelId ? text.filter((c) => c.id === channelId) : text;
}

/** Greets members who join a guild; the first candidate channel the bot may post in gets the message. */
export function attachWelcome(bot: LoopBot, config: WelcomeConfig) {
  bot.on("memberJoin", async ({ guildId, user }) => {
    if (user.isBot) return;
    try {
      const guild = (await bot.listGuilds()).find((g) => g.id === guildId);
      if (!guild) return;
      const own = config.guilds[guildId];
      const text = buildMessage(own?.message ?? config.default.message, { user: user.username, guild: guild.name });
      for (const channel of candidateChannels(await bot.listChannels(guildId), own?.channelId)) {
        try {
          await bot.sendMessage(channel.id, text);
          return;
        } catch {
          // no permission to send here: try the next one
        }
      }
    } catch (e) {
      bot.emit("error", e as Error);
    }
  });
}
