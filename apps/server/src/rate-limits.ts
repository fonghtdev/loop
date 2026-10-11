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
  "message-send": { max: 60, windowMs: MIN, by: "user" },
  "message-burst": { max: 10, windowMs: 5_000, by: "user" },
  "message-edit": { max: 60, windowMs: MIN, by: "user" },
  "friend-request": { max: 20, windowMs: HOUR, by: "user" },
  "invite-join": { max: 20, windowMs: HOUR, by: "user" },
  "invite-create": { max: 30, windowMs: HOUR, by: "user" },
  "guild-create": { max: 10, windowMs: HOUR, by: "user" },
  "attachment-create": { max: 60, windowMs: 10 * MIN, by: "user" },
  "voice-token": { max: 30, windowMs: MIN, by: "user" },
  "socket-connect": { max: 60, windowMs: MIN, by: "ip" },
  "socket-subscribe": { max: 100, windowMs: MIN, by: "socket" },
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
  "POST /channels/:channelId/messages": ["message-burst", "message-send"],
  "POST /dms/:dmId/messages": ["message-burst", "message-send"],
  "PATCH /messages/:messageId": ["message-edit"],
  "DELETE /messages/:messageId": ["message-edit"],
  "POST /friends/requests": ["friend-request"],
  "POST /invites/:code/join": ["invite-join"],
  "POST /guilds/:guildId/invites": ["invite-create"],
  "POST /guilds": ["guild-create"],
  "POST /attachments": ["attachment-create"],
  "POST /channels/:channelId/voice/token": ["voice-token"],
  "POST /dms/:dmId/call": ["voice-token"],
  // Global limit only: reads, and writes that need a membership/permission the caller can only get through the above.
  ...only(
    "POST /auth/logout", "GET /me",
    "GET /guilds", "GET /guilds/:guildId", "DELETE /guilds/:guildId", "POST /guilds/:guildId/channels",
    "DELETE /guilds/:guildId/channels/:channelId", "GET /guilds/:guildId/members", "DELETE /guilds/:guildId/members/me",
    "DELETE /guilds/:guildId/members/:userId", "POST /guilds/:guildId/transfer",
    "GET /guilds/:guildId/roles", "POST /guilds/:guildId/roles", "PATCH /guilds/:guildId/roles/:roleId",
    "DELETE /guilds/:guildId/roles/:roleId", "PUT /guilds/:guildId/members/:userId/roles/:roleId",
    "DELETE /guilds/:guildId/members/:userId/roles/:roleId", "PUT /channels/:channelId/overwrites/:roleId",
    "DELETE /channels/:channelId/overwrites/:roleId", "GET /channels/:channelId/messages",
    "POST /attachments/:id/complete", "GET /attachments/:id",
    "GET /friends", "POST /friends/requests/:userId/accept", "DELETE /friends/requests/:userId", "DELETE /friends/:userId",
    "GET /blocks", "PUT /blocks/:userId", "DELETE /blocks/:userId",
    "POST /dms", "GET /dms", "GET /dms/:dmId/messages",
    "GET /channels/:channelId/voice", "POST /dms/:dmId/call/decline",
  ),
};

/** Never throttled, with the reason. */
export const EXEMPT: Record<string, string> = {
  "POST /livekit/webhook": "authenticated by LiveKit's signature; throttling it would lose room events",
};
