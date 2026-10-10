import { readFileSync } from "node:fs";
import { DEFAULT_EVERYONE_PERMISSIONS, Permission as P } from "@loop/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, makeRole, resetDb, setEveryone, signUp } from "../../test/helpers.js";
import { addVoiceChannel } from "../../test/voice.js";

const app = buildApp(env);
const call = caller(app);
const status = async (...args: Parameters<typeof call>) => (await call(...args)).statusCode;

beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("the voice bits", () => {
  it("a new guild's @everyone gets CONNECT, SPEAK and VIDEO (1811)", async () => {
    const owner = await signUp(app, "owner");
    const { guild } = await guildWith(app, owner);
    expect((await prisma.role.findUniqueOrThrow({ where: { id: guild.id } })).permissions).toBe(1811);
    expect(DEFAULT_EVERYONE_PERMISSIONS).toBe(1811);
  });

  it("the migration ORs the three bits into every @everyone and touches no other role", async () => {
    const owner = await signUp(app, "owner");
    const { guild: plain } = await guildWith(app, owner);
    const { guild: custom } = await guildWith(app, owner);
    await setEveryone(plain.id, 19);
    await setEveryone(custom.id, P.VIEW_CHANNEL | P.MANAGE_ROLES);
    const other = await makeRole(plain.id, 1, P.KICK_MEMBERS);
    const sql = readFileSync(new URL("../../prisma/migrations/20261010090000_voice_permissions/migration.sql", import.meta.url), "utf8");
    await prisma.$executeRawUnsafe(sql);
    const perms = async (id: string) => (await prisma.role.findUniqueOrThrow({ where: { id } })).permissions;
    expect(await perms(plain.id)).toBe(1811);
    expect(await perms(custom.id)).toBe(P.VIEW_CHANNEL | P.MANAGE_ROLES | 1792); // customised roles gain the bits too
    expect(await perms(other.id)).toBe(P.KICK_MEMBERS);
  });
});

/** Anti-escalation applies to the new bits through the existing code: a role manager cannot hand out what they lack. */
describe("anti-escalation for SPEAK", () => {
  async function setup(actorPerms: number) {
    const [owner, actor, target] = await Promise.all(["owner", "actor", "target"].map((n) => signUp(app, n)));
    const { guild } = await guildWith(app, owner, actor, target);
    const voice = await addVoiceChannel(app, owner, guild.id);
    await setEveryone(guild.id, P.VIEW_CHANNEL | P.CONNECT);
    await makeRole(guild.id, 5, P.MANAGE_ROLES | actorPerms, [actor.id]);
    const low = await makeRole(guild.id, 1, 0);
    const above = await makeRole(guild.id, 9, 0);
    return { owner, actor, target, guild, voice, low, above, base: `/guilds/${guild.id}` };
  }

  it("without SPEAK: cannot create a role with it, add it to a role, or allow it in a channel", async () => {
    const s = await setup(0);
    expect(await status("POST", `${s.base}/roles`, s.actor.token, { name: "dj", permissions: P.SPEAK })).toBe(403);
    expect(await status("PATCH", `${s.base}/roles/${s.low.id}`, s.actor.token, { permissions: P.SPEAK })).toBe(403);
    expect(await status("PUT", `/channels/${s.voice.id}/overwrites/${s.low.id}`, s.actor.token, { allow: P.SPEAK, deny: 0 })).toBe(403);
  });

  it("without SPEAK: cannot assign a role that carries it, nor remove one", async () => {
    const s = await setup(0);
    const dj = await makeRole(s.guild.id, 2, P.SPEAK);
    expect(await status("PUT", `${s.base}/members/${s.target.id}/roles/${dj.id}`, s.actor.token)).toBe(403);
    await prisma.memberRole.create({ data: { guildId: s.guild.id, userId: s.target.id, roleId: dj.id } });
    expect(await status("DELETE", `${s.base}/members/${s.target.id}/roles/${dj.id}`, s.actor.token)).toBe(403);
  });

  it("without SPEAK: cannot lift someone's deny of it either (that grants it)", async () => {
    const s = await setup(0);
    await prisma.channelOverwrite.create({ data: { guildId: s.guild.id, channelId: s.voice.id, roleId: s.low.id, allow: 0, deny: P.SPEAK } });
    expect(await status("DELETE", `/channels/${s.voice.id}/overwrites/${s.low.id}`, s.actor.token)).toBe(403);
  });

  it("holding SPEAK allows granting it to a role below, but the hierarchy still forbids roles above", async () => {
    const s = await setup(P.SPEAK);
    expect(await status("POST", `${s.base}/roles`, s.actor.token, { name: "dj", permissions: P.SPEAK })).toBe(201);
    expect(await status("PATCH", `${s.base}/roles/${s.low.id}`, s.actor.token, { permissions: P.SPEAK })).toBe(200);
    expect(await status("PATCH", `${s.base}/roles/${s.above.id}`, s.actor.token, { permissions: P.SPEAK })).toBe(403);
  });

  it("ADMINISTRATOR passes the bits check but not the hierarchy", async () => {
    const s = await setup(P.ADMINISTRATOR);
    expect(await status("PATCH", `${s.base}/roles/${s.low.id}`, s.actor.token, { permissions: P.SPEAK | P.VIDEO })).toBe(200);
    expect(await status("PATCH", `${s.base}/roles/${s.above.id}`, s.actor.token, { permissions: P.SPEAK })).toBe(403);
  });
});
