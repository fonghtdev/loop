# Loop music bot

Plays music from YouTube in a voice channel. Commands are text messages:

| Command | What it does |
|---|---|
| `!play <name or YouTube link>` | Joins the voice channel you are in and plays, or queues (max 25). Links: `youtube.com`, `m./music.youtube.com`, `youtu.be`; anything else is a search. One video only, never the playlist. Live streams and videos over 3 hours are refused. |
| `!skip` | Next track |
| `!stop` | Stops, clears the queue, leaves the channel |
| `!queue` | Now playing and up to 10 queued tracks |
| `!help` | This list |

The bot leaves when the queue is empty. If it is busy in another voice channel of the same server, `!play` from elsewhere is refused.

> **Warning.** Downloading audio from YouTube with yt-dlp can break YouTube's Terms of Service, and the music may be copyrighted. Use it only inside a small private group, at your own responsibility.

## Setup
1. Install the tools: `brew install yt-dlp ffmpeg` (macOS). Other paths: set `YTDLP_PATH` / `FFMPEG_PATH` (default: `yt-dlp` / `ffmpeg` from `PATH`).
2. Create the bot (needs your access token): `POST /bots {"name":"music_bot"}` returns `{bot, token}`; the token is shown once.
3. Put it in a server: create an invite (`POST /guilds/:id/invites`), the bot joins with its own access token (see `packages/bots/welcome/README.md`, step 2).
   It needs VIEW_CHANNEL + SEND_MESSAGES in the text channel and VIEW_CHANNEL + CONNECT + SPEAK in the voice channels.
4. Run: `pnpm --filter @loop/bot-music build`, then
   `LOOP_API_URL=http://localhost:3000 LOOP_BOT_TOKEN=<bot token> pnpm --filter @loop/bot-music start`.
