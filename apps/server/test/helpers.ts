import type { buildApp } from "../src/app.js";
import { prisma } from "../src/db.js";

export const env = { databaseUrl: "", redisUrl: process.env.REDIS_URL!, jwtSecret: "test-secret-test-secret-test-secret-1234", port: 0 };

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

export const resetDb = () =>
  prisma.$executeRaw`TRUNCATE "Message", "Invite", "Member", "Channel", "Guild", "Session", "User" CASCADE`;

type User = { token: string; id: string; name: string };

/** Routes of the social plugin (friends, blocks, DMs); they have their own guard test. */
export const isSocialRoute = (route: string) => /^[A-Z]+ \/(friends|blocks|dms)\b/.test(route);

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
