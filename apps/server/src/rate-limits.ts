// The one place that decides who may call what how often. Every HTTP route must appear in ROUTES or EXEMPT:
// registering one that does not fails at startup (see limiter.ts), so a new route cannot ship undecided.
// `by`: ip = client address; user = the authenticated user id (the IP when there is none, e.g. login);
// ip+email = the pair, so an attacker can only exhaust budgets that include their own IP; socket = one socket.
const MIN = 60_000;
const HOUR = 60 * MIN;

export type Policy = { max: number; windowMs: number; by: "ip" | "user" | "ip+email" | "socket" };

export const POLICIES = {
  // Added to every non-exempt route on top of its own policies.
  global: { max: 300, windowMs: MIN, by: "user" },
  "login-ip": { max: 10, windowMs: MIN, by: "ip" },
  "login-email": { max: 5, windowMs: 5 * MIN, by: "ip+email" },
  register: { max: 5, windowMs: HOUR, by: "ip" },
  refresh: { max: 30, windowMs: MIN, by: "ip" },
  // A bot logs in again every 15 min; tight per IP so nobody can spray guesses (the secret is 256 bits anyway).
  "bot-login": { max: 10, windowMs: MIN, by: "ip" },
  "bot-manage": { max: 20, windowMs: HOUR, by: "user" },
  "message-send": { max: 60, windowMs: MIN, by: "user" },
  "message-burst": { max: 10, windowMs: 5_000, by: "user" },
  "message-edit": { max: 60, windowMs: MIN, by: "user" },
  "reaction-change": { max: 120, windowMs: MIN, by: "user" },
  "message-pin": { max: 30, windowMs: MIN, by: "user" },
  // PUT .../read: the desktop sends at most one per 2 s per conversation.
  "read-state": { max: 120, windowMs: MIN, by: "user" },
  // Each search runs a full-text query over the caller's visible channels.
  "message-search": { max: 30, windowMs: MIN, by: "user" },
  // Creating, renaming, (un)archiving and deleting threads (each one fans out to every member who sees the channel).
  "thread-change": { max: 30, windowMs: HOUR, by: "user" },
  "friend-request": { max: 20, windowMs: HOUR, by: "user" },
  // Creating, adding to, removing from and renaming group DMs (each one fans out to up to 10 people). Leaving is not limited.
  "group-dm-change": { max: 30, windowMs: HOUR, by: "user" },
  "invite-join": { max: 20, windowMs: HOUR, by: "user" },
  "invite-create": { max: 30, windowMs: HOUR, by: "user" },
  "guild-create": { max: 10, windowMs: HOUR, by: "user" },
  // Ban / unban (a ban can delete up to a week of someone's messages), server mute / deafen, AutoMod rule changes.
  "guild-moderation": { max: 60, windowMs: HOUR, by: "user" },
  "attachment-create": { max: 60, windowMs: 10 * MIN, by: "user" },
  "voice-token": { max: 30, windowMs: MIN, by: "user" },
  "voice-move": { max: 60, windowMs: MIN, by: "user" },
  "socket-connect": { max: 60, windowMs: MIN, by: "ip" },
  "socket-subscribe": { max: 100, windowMs: MIN, by: "socket" },
  // `typing` relays: at most one per 2 s per socket (clients send one per 5 s while typing); the rest are dropped silently.
  "socket-typing": { max: 1, windowMs: 2_000, by: "socket" },
  // Live pushes of `presence:away` flips (each one fans out to friends + guild co-members); idle detection is minutes apart.
  "socket-presence": { max: 20, windowMs: MIN, by: "socket" },
  // Each change fans out the same way.
  "status-set": { max: 20, windowMs: MIN, by: "user" },
  "profile-update": { max: 20, windowMs: HOUR, by: "user" },
  // Hands out a presigned PUT and replaces the caller's previous pending upload (one pending per kind and target).
  "image-upload": { max: 20, windowMs: HOUR, by: "user" },
  // Unauthenticated avatar / banner / icon reads (<img> cannot send a token): keyed by IP, one 302 each.
  "image-read": { max: 300, windowMs: MIN, by: "ip" },
  // Each search or trending page is a GIPHY call (the provider quota is shared by everyone; repeats are cached 5 min).
  "gif-search": { max: 60, windowMs: MIN, by: "user" },
  // Link previews: URLs one user may make the server fetch (cache misses only). Counted in-process by src/embeds,
  // and on even with RATE_LIMIT=off; over budget the preview is just skipped (the message is never refused).
  "link-preview": { max: 60, windowMs: HOUR, by: "user" },
} satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;
/** Test seam: smaller numbers / windows for chosen policies. */
export type PolicyOverrides = Partial<Record<PolicyName, Pick<Policy, "max" | "windowMs">>>;

const only = (...routes: string[]) => Object.fromEntries(routes.map((r) => [r, [] as PolicyName[]]));

/** "METHOD /url" -> the policies it adds to `global` (HEAD is judged as GET). */
export const ROUTES: Record<string, PolicyName[]> = {
  "POST /auth/login": ["login-ip", "login-email"],
  "POST /auth/register": ["register"],
  "POST /auth/refresh": ["refresh"],
  "POST /auth/bot-login": ["bot-login"],
  "POST /bots": ["bot-manage"],
  "POST /bots/:botId/token": ["bot-manage"],
  "DELETE /bots/:botId": ["bot-manage"],
  "POST /channels/:channelId/messages": ["message-burst", "message-send"],
  "POST /dms/:dmId/messages": ["message-burst", "message-send"],
  "PATCH /messages/:messageId": ["message-edit"],
  "DELETE /messages/:messageId": ["message-edit"],
  "PUT /messages/:messageId/reactions/:emoji": ["reaction-change"],
  "DELETE /messages/:messageId/reactions/:emoji": ["reaction-change"],
  "PUT /channels/:channelId/read": ["read-state"],
  "PUT /dms/:dmId/read": ["read-state"],
  "GET /guilds/:guildId/messages/search": ["message-search"],
  "GET /dms/:dmId/messages/search": ["message-search"],
  "PUT /messages/:messageId/pin": ["message-pin"],
  "DELETE /messages/:messageId/pin": ["message-pin"],
  "POST /channels/:channelId/messages/:messageId/thread": ["thread-change"],
  "PATCH /threads/:threadId": ["thread-change"],
  "DELETE /threads/:threadId": ["thread-change"],
  "POST /friends/requests": ["friend-request"],
  "POST /dms/group": ["group-dm-change"],
  "POST /dms/:dmId/participants": ["group-dm-change"],
  "DELETE /dms/:dmId/participants/:userId": ["group-dm-change"],
  "PATCH /dms/:dmId": ["group-dm-change"],
  "POST /invites/:code/join": ["invite-join"],
  "POST /guilds/:guildId/invites": ["invite-create"],
  "POST /guilds": ["guild-create"],
  "PUT /guilds/:guildId/bans/:userId": ["guild-moderation"],
  "DELETE /guilds/:guildId/bans/:userId": ["guild-moderation"],
  "PUT /channels/:channelId/voice/members/:userId/state": ["guild-moderation"],
  "POST /guilds/:guildId/automod/rules": ["guild-moderation"],
  "PATCH /guilds/:guildId/automod/rules/:ruleId": ["guild-moderation"],
  "DELETE /guilds/:guildId/automod/rules/:ruleId": ["guild-moderation"],
  "POST /attachments": ["attachment-create"],
  "POST /channels/:channelId/voice/token": ["voice-token"],
  "POST /dms/:dmId/call": ["voice-token"],
  "POST /channels/:channelId/voice/move": ["voice-move"],
  "PUT /me/status": ["status-set"],
  "PATCH /me/profile": ["profile-update"],
  "POST /me/avatar/upload": ["image-upload"],
  "POST /me/banner/upload": ["image-upload"],
  "POST /guilds/:guildId/icon/upload": ["image-upload"],
  "GET /users/:userId/avatar": ["image-read"],
  "GET /users/:userId/banner": ["image-read"],
  "GET /guilds/:guildId/icon": ["image-read"],
  "GET /embeds/:embedId/thumbnail": ["image-read"],
  "GET /gifs/search": ["gif-search"],
  "GET /gifs/trending": ["gif-search"],
  // Global limit only: reads, and writes that need a membership/permission the caller can only get through the above.
  ...only(
    "POST /auth/logout", "GET /me", "GET /me/unread", "GET /me/status", "GET /bots",
    "GET /users/:userId/profile", "GET /gifs/config", "POST /me/avatar/complete", "DELETE /me/avatar", "POST /me/banner/complete", "DELETE /me/banner",
    "POST /guilds/:guildId/icon/complete", "DELETE /guilds/:guildId/icon", "PATCH /guilds/:guildId", "PATCH /channels/:channelId",
    "GET /guilds", "GET /guilds/:guildId", "DELETE /guilds/:guildId", "POST /guilds/:guildId/channels",
    "DELETE /guilds/:guildId/channels/:channelId",
    "POST /guilds/:guildId/categories", "PATCH /guilds/:guildId/categories/:categoryId",
    "DELETE /guilds/:guildId/categories/:categoryId", "PUT /guilds/:guildId/layout", "GET /guilds/:guildId/members", "DELETE /guilds/:guildId/members/me",
    "DELETE /guilds/:guildId/members/:userId", "POST /guilds/:guildId/transfer",
    "GET /guilds/:guildId/roles", "POST /guilds/:guildId/roles", "PATCH /guilds/:guildId/roles/:roleId",
    "DELETE /guilds/:guildId/roles/:roleId", "PUT /guilds/:guildId/members/:userId/roles/:roleId",
    "DELETE /guilds/:guildId/members/:userId/roles/:roleId", "PUT /channels/:channelId/overwrites/:roleId",
    "DELETE /channels/:channelId/overwrites/:roleId", "GET /channels/:channelId/messages", "GET /channels/:channelId/pins",
    "GET /channels/:channelId/threads",
    "GET /guilds/:guildId/bans", "GET /guilds/:guildId/audit-log", "GET /guilds/:guildId/automod/rules", "GET /guilds/:guildId/invites", "DELETE /guilds/:guildId/invites/:code", "PUT /guilds/:guildId/roles/order",
    "PUT /channels/:channelId/overwrites/members/:userId", "DELETE /channels/:channelId/overwrites/members/:userId",
    "POST /attachments/:id/complete", "GET /attachments/:id",
    "GET /friends", "POST /friends/requests/:userId/accept", "DELETE /friends/requests/:userId", "DELETE /friends/:userId",
    "GET /blocks", "PUT /blocks/:userId", "DELETE /blocks/:userId",
    "POST /dms", "GET /dms", "GET /dms/:dmId/messages", "GET /dms/:dmId/pins", "DELETE /dms/:dmId/participants/me",
    "GET /channels/:channelId/voice", "POST /dms/:dmId/call/decline",
  ),
};

/** Never throttled, with the reason. */
export const EXEMPT: Record<string, string> = {
  "GET /health": "load balancer / uptime probes poll it; it reveals nothing and takes no input",
  "POST /livekit/webhook": "authenticated by LiveKit's signature; throttling it would lose room events",
};
