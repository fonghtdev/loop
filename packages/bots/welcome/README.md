# Loop welcome bot

Greets people who join a server (guild).

1. Create the bot as a person (needs your access token): `POST /bots {"name":"welcome_bot"}` returns `{bot, token}`. The token is shown once.
2. Put the bot in a guild: an admin creates an invite (`POST /guilds/:id/invites`), the bot joins it with its own access token:
   `curl -X POST $LOOP_API_URL/auth/bot-login -H 'content-type: application/json' -d '{"token":"<bot token>"}'`, then
   `curl -X POST $LOOP_API_URL/invites/<code>/join -H 'authorization: Bearer <accessToken>'`.
   The bot needs VIEW and SEND_MESSAGES in the channel it greets in.
3. Write `welcome.config.json` (path in `WELCOME_CONFIG`, default `./welcome.config.json`):
   ```json
   { "default": { "message": "Chào mừng {user} đến với {guild}!" },
     "guilds": { "<guildId>": { "channelId": "<channelId>", "message": "optional per-guild text" } } }
   ```
   Without `channelId` the first text channel (display order) where the bot may post is used.
4. Run: `pnpm --filter @loop/bot-welcome build`, then
   `LOOP_API_URL=http://localhost:3000 LOOP_BOT_TOKEN=<bot token> pnpm --filter @loop/bot-welcome start`.
