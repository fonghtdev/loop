import { ApiError, type LoopBot, type Message } from "@loop/bot-sdk";
import { MAX_QUERY_LENGTH, PREFIX, parseCommand } from "./commands.js";
import { GuildPlayer, MAX_QUEUE, type Source } from "./player.js";
import { UserError } from "./source.js";

const LIST_LIMIT = 10;
const SLOW_HINT_MS = 4000;
const HELP = [
  `${PREFIX}play <tên bài | link YouTube> - phát hoặc thêm vào hàng đợi (không kèm tên: tiếp tục nếu đang tạm dừng)`,
  `${PREFIX}next <tên bài | link YouTube> - phát ngay sau bài đang phát (chèn lên đầu hàng đợi)`,
  `${PREFIX}pause - tạm dừng`,
  `${PREFIX}resume (hoặc ${PREFIX}continue) - phát tiếp`,
  `${PREFIX}skip - bỏ qua bài đang phát`,
  `${PREFIX}stop - dừng, xoá hàng đợi, rời kênh`,
  `${PREFIX}queue - xem hàng đợi`,
].join("\n");

type Session = { channelId: string; text: string; player: GuildPlayer };

/** Text commands (`!play`, `!next`, `!pause`, `!resume`, `!skip`, `!stop`, `!queue`, `!help`); one voice session per guild. */
export function attachMusic(bot: LoopBot, source: Source) {
  const sessions = new Map<string, Promise<Session>>();

  /** The guild whose text channel the message came from, with its voice channels. Null: not a text channel of a guild the bot is in. */
  async function locate(channelId: string) {
    for (const guild of await bot.listGuilds()) {
      const channels = await bot.listChannels(guild.id);
      if (channels.some((c) => c.id === channelId && c.type === "TEXT")) return { guildId: guild.id, voice: channels.filter((c) => c.type === "VOICE") };
    }
    return null;
  }

  async function voiceChannelOf(userId: string, voice: { id: string }[]) {
    const seats = await Promise.all(voice.map((c) => bot.voiceParticipants(c.id).catch(() => [])));
    return voice.find((_, i) => seats[i]!.some((p) => p.userId === userId))?.id;
  }

  function join(guildId: string, channelId: string, text: string) {
    let s = sessions.get(guildId);
    if (!s) {
      const created: Promise<Session> = bot.joinVoice(channelId).then((conn) => {
        const session: Session = {
          channelId,
          text,
          player: new GuildPlayer(
            conn,
            source,
            (t) => void bot.sendMessage(session.text, t).catch(() => {}),
            () => void sessions.delete(guildId),
          ),
        };
        return session;
      });
      created.catch(() => sessions.delete(guildId));
      sessions.set(guildId, (s = created));
    }
    return s;
  }

  async function play(m: Message, guildId: string, voice: { id: string }[], query: string, next = false) {
    if (!query) return `Dùng: ${PREFIX}${next ? "next" : "play"} <tên bài | link YouTube>`;
    if (query.length > MAX_QUERY_LENGTH) return `Yêu cầu dài quá (tối đa ${MAX_QUERY_LENGTH} ký tự).`;
    const channelId = await voiceChannelOf(m.author.id, voice);
    if (!channelId) return "Bạn cần vào một kênh thoại trước.";
    // a slow host can need minutes to look a song up: say so instead of staying silent
    const slow = setTimeout(() => void bot.sendMessage(m.channelId!, "Đang tìm bài, máy chủ chậm nên có thể mất vài phút...").catch(() => {}), SLOW_HINT_MS);
    const track = await source.resolve(query).finally(() => clearTimeout(slow));
    const session = await join(guildId, channelId, m.channelId!);
    if (session.channelId !== channelId) return "Mình đang phát ở kênh thoại khác.";
    session.text = m.channelId!;
    const ahead = session.player.add(track, next);
    if (ahead === null) return `Hàng đợi đầy (tối đa ${MAX_QUEUE} bài).`;
    return ahead ? (next ? `Sẽ phát tiếp theo: ${track.title}` : `Đã thêm vào hàng đợi (vị trí ${ahead}): ${track.title}`) : undefined; // the player announces what it starts
  }

  async function run(m: Message, cmd: { name: string; args: string }) {
    if (cmd.name === "help") return HELP;
    const where = await locate(m.channelId!);
    if (!where) return;
    const player = (await sessions.get(where.guildId))?.player;
    if (cmd.name === "play") return !cmd.args && player?.isPaused ? (player.resume(), "Đã phát tiếp.") : play(m, where.guildId, where.voice, cmd.args);
    if (cmd.name === "next" || cmd.name === "playnext") return play(m, where.guildId, where.voice, cmd.args, true);
    if (cmd.name === "pause") return player?.pause() ? `Đã tạm dừng. Gõ ${PREFIX}resume để phát tiếp.` : player?.isPaused ? "Đã tạm dừng rồi." : "Không có gì đang phát.";
    if (cmd.name === "resume" || cmd.name === "continue") return player?.resume() ? "Đã phát tiếp." : "Không có gì đang tạm dừng.";
    if (cmd.name === "skip") return player?.skip() ? "Đã bỏ qua." : "Không có gì đang phát.";
    if (cmd.name === "stop") return player ? (await player.stop(), "Đã dừng và rời kênh.") : "Mình không ở kênh thoại nào.";
    if (cmd.name === "queue") {
      if (!player?.current) return "Hàng đợi trống.";
      const next = player.queued;
      const lines = next.slice(0, LIST_LIMIT).map((t, i) => `${i + 1}. ${t.title}`);
      return [`${player.isPaused ? "Tạm dừng" : "Đang phát"}: ${player.current.title}`, ...lines, ...(next.length > LIST_LIMIT ? [`... và ${next.length - LIST_LIMIT} bài nữa`] : [])].join("\n");
    }
  }

  bot.on("message", async (m) => {
    const cmd = m.author.isBot || !m.channelId ? null : parseCommand(m.content);
    if (!cmd) return;
    try {
      const reply = await run(m, cmd);
      if (reply) await bot.sendMessage(m.channelId!, reply);
    } catch (e) {
      const text = e instanceof UserError ? e.message : e instanceof ApiError && e.status === 403 ? "Mình thiếu quyền vào hoặc nói ở kênh thoại đó." : "Có lỗi, thử lại sau.";
      if (!(e instanceof UserError)) bot.emit("error", e as Error);
      await bot.sendMessage(m.channelId!, text).catch(() => {});
    }
  });
}
