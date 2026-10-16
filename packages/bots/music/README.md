# Loop music bot

Plays music from YouTube (and SoundCloud) in a voice channel. Commands are text messages:

| Command | What it does |
|---|---|
| `!play <name or link>` | Joins the voice channel you are in and plays, or queues (max 25). A name is searched on YouTube first; if YouTube refuses the host (bot check, 403/429) the bot says so and tries SoundCloud, and tells which source played. Links: YouTube, SoundCloud and any other public http(s) link yt-dlp understands (never an IP address or internal name). One track only, never the playlist. Live streams and tracks over 3 hours are refused. |
| `!play sc <name>` | Searches SoundCloud only |
| `!next <name or link>` (or `!playnext`) | Same as `!play`, but the song goes to the FRONT of the queue and plays right after the current one |
| `!pause` | Pauses (the bot leaves by itself after 10 minutes of pause) |
| `!resume` or `!continue` | Plays on. `!play` with no name does the same while paused |
| `!skip` | Next track |
| `!stop` | Stops, clears the queue, leaves the channel |
| `!queue` | Now playing and up to 10 queued tracks |
| `!help` | This list |

The bot leaves when the queue is empty. If it is busy in another voice channel of the same server, `!play` from elsewhere is refused.

> **Warning.** Downloading audio from YouTube with yt-dlp can break YouTube's Terms of Service, and the music may be copyrighted. Use it only inside a small private group, at your own responsibility.

While a track plays the bot prepares the next one in the background, so the gap between songs is short. Searches are remembered for 6 hours (100 entries).

## Setup
1. Install the tools: `brew install yt-dlp ffmpeg` (macOS). Other paths: set `YTDLP_PATH` / `FFMPEG_PATH` (default: `yt-dlp` / `ffmpeg` from `PATH`).
   On a hosted machine YouTube usually answers "Sign in to confirm you're not a bot": set `YTDLP_COOKIES` to a cookies.txt file (see docs/DEPLOY.md, section 17).
2. Create the bot (needs your access token): `POST /bots {"name":"music_bot"}` returns `{bot, token}`; the token is shown once.
3. Put it in a server: create an invite (`POST /guilds/:id/invites`), the bot joins with its own access token (see `packages/bots/welcome/README.md`, step 2).
   It needs VIEW_CHANNEL + SEND_MESSAGES in the text channel and VIEW_CHANNEL + CONNECT + SPEAK in the voice channels.
   Optional: `MUSIC_SOURCES=youtube,soundcloud` (default; the order searches try, `soundcloud` alone turns YouTube off), `YTDLP_YT_CLIENT` (a yt-dlp YouTube player client, untested against blocking).
4. Run: `pnpm --filter @loop/bot-music build`, then
   `LOOP_API_URL=http://localhost:3000 LOOP_BOT_TOKEN=<bot token> pnpm --filter @loop/bot-music start`.
