import type { buildApp } from "../src/app.js";
import { removeObjects } from "../src/attachments/sweep.js";
import { prisma } from "../src/db.js";
import { createStorage } from "../src/storage.js";
import { dmRoom, voiceRoom } from "../src/voice/rooms.js";
import { createLivekit } from "../src/voice/livekit.js";

export const env = {
  databaseUrl: "",
  redisUrl: process.env.REDIS_URL!,
  jwtSecret: "test-secret-test-secret-test-secret-1234",
  livekit: {
    url: process.env.LIVEKIT_URL!,
    apiUrl: process.env.LIVEKIT_API_URL!,
    apiKey: process.env.LIVEKIT_API_KEY!,
    apiSecret: process.env.LIVEKIT_API_SECRET!,
  },
  port: 0,
  rateLimit: false, // the suite signs up dozens of users from one address; rate-limit tests turn it on
  trustProxy: false as boolean | number,
  corsOrigins: [] as string[],
  s3: {
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKey: process.env.S3_ACCESS_KEY!,
    secretKey: process.env.S3_SECRET_KEY!,
  },
};
export const testStorage = createStorage(env.s3);

type App = ReturnType<typeof buildApp>;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const caller = (app: App) => (method: Method, url: string, token?: string, payload?: object) =>
  app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });

export const signUp = async (app: App, name: string) => {
  const body = (
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: `${name}@example.com`, username: name, password: "correct-horse" },
    })
  ).json();
  return { token: body.accessToken as string, id: body.user.id as string, name };
};

/** Closes the LiveKit rooms of every channel and DM in the DB (only those: the server may hold other rooms). */
async function closeKnownRooms() {
  const names = [
    ...(await prisma.channel.findMany({ select: { id: true } })).map((c) => voiceRoom(c.id)),
    ...(await prisma.dmChannel.findMany({ select: { id: true } })).map((d) => dmRoom(d.id)),
  ];
  if (!names.length) return;
  const livekit = createLivekit(env.livekit);
  for (const room of await livekit.listRooms(names)) await livekit.deleteRoom(room.name);
}

/** Empties the test bucket's known objects (every key is in an Attachment row), the LiveKit rooms, then the tables. */
export async function resetDb() {
  await closeKnownRooms();
  await removeObjects(testStorage, (await prisma.attachment.findMany({ select: { id: true } })).map((a) => a.id));
  await prisma.$executeRaw`TRUNCATE "Message", "Invite", "Member", "Channel", "Guild", "Session", "User" CASCADE`;
}

/** Routes of the attachments plugin; they have their own guard test. */
export const isAttachmentRoute = (route: string) => /^[A-Z]+ \/attachments\b/.test(route);

type User = { token: string; id: string; name: string };

/** Routes of the social plugin (friends, blocks, DMs); they have their own guard test. */
export const isSocialRoute = (route: string) => /^[A-Z]+ \/(friends|blocks|dms)\b(?!\/:dmId\/call)/.test(route);

/** Routes of the voice plugin (channel voice, DM calls, LiveKit webhook); they have their own guard test. */
export const isVoiceRoute = (route: string) => /^[A-Z]+ (\/channels\/:channelId\/voice\b|\/dms\/:dmId\/call\b|\/livekit\b)/.test(route);

/** `a` asks `b` by username, `b` accepts. */
export async function befriend(app: App, a: User, b: User) {
  const call = caller(app);
  await call("POST", "/friends/requests", a.token, { username: b.name });
  await call("POST", `/friends/requests/${a.id}/accept`, b.token);
}

/** Owner creates a guild; every other user joins it through one invite. */
export async function guildWith(app: App, owner: User, ...members: User[]) {
  const call = caller(app);
  const { guild, channels } = (await call("POST", "/guilds", owner.token, { name: "HQ" })).json();
  const { code } = (await call("POST", `/guilds/${guild.id}/invites`, owner.token, {})).json();
  for (const m of members) await call("POST", `/invites/${code}/join`, m.token);
  return { guild: guild as { id: string; ownerId: string }, general: channels[0] as { id: string } };
}

/** Straight to the DB: roles at chosen positions without going through the routes under test. */
export async function makeRole(guildId: string, position: number, permissions = 0, holders: string[] = []) {
  const role = await prisma.role.create({ data: { guildId, name: `role${position}`, permissions, position } });
  await prisma.memberRole.createMany({ data: holders.map((userId) => ({ guildId, userId, roleId: role.id })) });
  return role;
}

export const setEveryone = (guildId: string, permissions: number) =>
  prisma.role.update({ where: { id: guildId }, data: { permissions } });

export const sizeOf = async (key: string) => (await testStorage.head(key))?.size ?? null;

/** A real 1x1 PNG. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

type Target = { channelId: string } | { dmChannelId: string };

/** Step 1 + 2 + 3 of the upload flow. `declared` overrides what is announced (type / size lies). */
export async function uploadAttachment(
  app: App,
  token: string,
  target: Target,
  bytes: Uint8Array = PNG,
  declared: { filename?: string; contentType?: string; size?: number } = {},
) {
  const call = caller(app);
  const create = await call("POST", "/attachments", token, {
    filename: "pic.png",
    contentType: "image/png",
    size: bytes.length,
    ...declared,
    ...target,
  });
  const { id, uploadUrl, headers } = create.json();
  const put = uploadUrl ? await fetch(uploadUrl, { method: "PUT", headers, body: bytes }) : undefined;
  const complete = id ? await call("POST", `/attachments/${id}/complete`, token) : undefined;
  return { id: id as string, create, put, complete: complete!, dto: complete?.json() };
}
