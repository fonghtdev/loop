import { readFileSync } from "node:fs";
import { DEFAULT_EVERYONE_PERMISSIONS, Permission as P } from "@loop/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, makeRole, resetDb, setEveryone, signUp } from "../../test/helpers.js";

const app = buildApp(env);
const call = caller(app);

/**
 * owner; mod (top role at 5 with `modPerms`); peer (a role at 5 too); low (a role at 2); plain (no role).
 * Plus spare roles below (2), equal to (5) and above (7) the mod.
 */
async function setup(modPerms = P.MANAGE_ROLES | P.KICK_MEMBERS) {
  const [owner, mod, peer, low, plain] = await Promise.all(["owner", "mod", "peer", "low", "plain"].map((n) => signUp(app, n)));
  const { guild, general } = await guildWith(app, owner, mod, peer, low, plain);
  const g = guild.id;
  const roles = {
    mod: await makeRole(g, 5, modPerms, [mod.id]),
    equal: await makeRole(g, 5, 0, [peer.id]),
    above: await makeRole(g, 7),
    below: await makeRole(g, 2, 0, [low.id]),
  };
  return { owner, mod, peer, low, plain, guild, general, roles, base: `/guilds/${g}` };
}
type S = Awaited<ReturnType<typeof setup>>;
const roleUrl = (s: S, roleId: string) => `${s.base}/roles/${roleId}`;
const assignUrl = (s: S, userId: string, roleId: string) => `${s.base}/members/${userId}/roles/${roleId}`;
const status = async (...args: Parameters<typeof call>) => (await call(...args)).statusCode;
const roleIdsOf = async (guildId: string, userId: string) =>
  (await prisma.memberRole.findMany({ where: { guildId, userId } })).map((r) => r.roleId);

beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("roles API", () => {
  it("a new guild has exactly @everyone (id = guild id, position 0, default perms)", async () => {
    const owner = await signUp(app, "owner");
    const { guild } = await guildWith(app, owner);
    const roles = (await call("GET", `/guilds/${guild.id}/roles`, owner.token)).json();
    expect(roles).toEqual([expect.objectContaining({ id: guild.id, name: "@everyone", position: 0, permissions: DEFAULT_EVERYONE_PERMISSIONS })]);
  });

  it("new roles go to position 1 and push the others up, keeping their order", async () => {
    const s = await setup();
    const a = (await call("POST", `${s.base}/roles`, s.owner.token, { name: "a" })).json();
    const b = (await call("POST", `${s.base}/roles`, s.owner.token, { name: "b", permissions: P.ADMINISTRATOR })).json();
    expect(b.position).toBe(1);
    const roles: { id: string; position: number }[] = (await call("GET", `${s.base}/roles`, s.owner.token)).json();
    expect(Object.fromEntries(roles.map((r) => [r.id, r.position]))).toEqual({
      [s.guild.id]: 0,
      [b.id]: 1,
      [a.id]: 2,
      [s.roles.below.id]: 4,
      [s.roles.mod.id]: 7,
      [s.roles.equal.id]: 7,
      [s.roles.above.id]: 9,
    });
  });

  it("validates bodies: unknown bits, bad names, empty patch", async () => {
    const s = await setup();
    expect(await status("POST", `${s.base}/roles`, s.owner.token, { name: "x", permissions: 256 })).toBe(400);
    expect(await status("POST", `${s.base}/roles`, s.owner.token, { name: "" })).toBe(400);
    expect(await status("POST", `${s.base}/roles`, s.owner.token, { name: "@everyone" })).toBe(400);
    expect(await status("PATCH", roleUrl(s, s.roles.below.id), s.owner.token, {})).toBe(400);
    expect(await status("PUT", `/channels/${s.general.id}/overwrites/${s.guild.id}`, s.owner.token, { allow: P.KICK_MEMBERS, deny: 0 })).toBe(400);
    expect(await status("PATCH", roleUrl(s, "nope"), s.owner.token, { name: "x" })).toBe(404);
  });

  it("members list carries roleIds; a kicked member loses their roles and comes back without them", async () => {
    const s = await setup();
    const low = (await call("GET", `${s.base}/members`, s.owner.token)).json().find((m: { username: string }) => m.username === "low");
    expect(low.roleIds).toEqual([s.roles.below.id]);
    expect(await status("DELETE", `${s.base}/members/${s.low.id}`, s.mod.token)).toBe(204);
    expect(await status("GET", s.base, s.low.token)).toBe(404);
    expect(await roleIdsOf(s.guild.id, s.low.id)).toEqual([]);
  });
});

describe("anti-escalation", () => {
  it("MANAGE_ROLES cannot edit, delete, assign or unassign a role at or above its top role", async () => {
    const s = await setup();
    for (const role of [s.roles.above, s.roles.equal, s.roles.mod]) {
      expect(await status("PATCH", roleUrl(s, role.id), s.mod.token, { name: "x" }), `edit ${role.position}`).toBe(403);
      expect(await status("DELETE", roleUrl(s, role.id), s.mod.token), `delete ${role.position}`).toBe(403);
      expect(await status("PUT", assignUrl(s, s.plain.id, role.id), s.mod.token), `assign ${role.position}`).toBe(403);
      expect(await status("PUT", assignUrl(s, s.mod.id, role.id), s.mod.token), `self-assign ${role.position}`).toBe(403);
    }
    expect(await status("DELETE", assignUrl(s, s.peer.id, s.roles.equal.id), s.mod.token)).toBe(403);
    expect(await roleIdsOf(s.guild.id, s.mod.id)).toEqual([s.roles.mod.id]);
    // strictly below is fine
    expect(await status("PATCH", roleUrl(s, s.roles.below.id), s.mod.token, { name: "x" })).toBe(200);
    expect(await status("PUT", assignUrl(s, s.plain.id, s.roles.below.id), s.mod.token)).toBe(204);
    expect(await status("DELETE", assignUrl(s, s.plain.id, s.roles.below.id), s.mod.token)).toBe(204);
  });

  it("cannot grant, or take away, bits it does not hold", async () => {
    const s = await setup(P.MANAGE_ROLES | P.VIEW_CHANNEL);
    expect(await status("POST", `${s.base}/roles`, s.mod.token, { name: "x", permissions: P.KICK_MEMBERS })).toBe(403);
    expect(await status("POST", `${s.base}/roles`, s.mod.token, { name: "x", permissions: P.ADMINISTRATOR })).toBe(403);
    expect(await status("PATCH", roleUrl(s, s.roles.below.id), s.mod.token, { permissions: P.KICK_MEMBERS })).toBe(403);
    expect(await status("PATCH", roleUrl(s, s.guild.id), s.mod.token, { permissions: DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_CHANNELS })).toBe(403);
    await prisma.role.update({ where: { id: s.roles.below.id }, data: { permissions: P.KICK_MEMBERS } });
    expect(await status("PATCH", roleUrl(s, s.roles.below.id), s.mod.token, { permissions: 0 })).toBe(403);
    // a role carrying bits the mod lacks cannot be handed out or deleted either
    expect(await status("PUT", assignUrl(s, s.plain.id, s.roles.below.id), s.mod.token)).toBe(403);
    expect(await status("DELETE", roleUrl(s, s.roles.below.id), s.mod.token)).toBe(403);
    expect(await status("PUT", `/channels/${s.general.id}/overwrites/${s.roles.below.id}`, s.mod.token, { allow: P.MANAGE_MESSAGES, deny: 0 })).toBe(403);
    // bits it holds are fine
    expect(await status("POST", `${s.base}/roles`, s.mod.token, { name: "ok", permissions: P.MANAGE_ROLES | P.VIEW_CHANNEL })).toBe(201);
    expect(await status("PATCH", roleUrl(s, s.roles.below.id), s.mod.token, { permissions: P.KICK_MEMBERS | P.VIEW_CHANNEL })).toBe(200);
  });

  it("@everyone: only its permissions can change; never renamed, deleted or assigned (owner included)", async () => {
    const s = await setup(P.MANAGE_ROLES | DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_MESSAGES);
    for (const token of [s.mod.token, s.owner.token]) {
      expect(await status("PATCH", roleUrl(s, s.guild.id), token, { name: "all" })).toBe(400);
      expect(await status("DELETE", roleUrl(s, s.guild.id), token)).toBe(400);
      expect(await status("PUT", assignUrl(s, s.plain.id, s.guild.id), token)).toBe(400);
      expect(await status("DELETE", assignUrl(s, s.plain.id, s.guild.id), token)).toBe(400);
    }
    const res = await call("PATCH", roleUrl(s, s.guild.id), s.mod.token, { permissions: DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_MESSAGES });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "@everyone", position: 0 });
  });

  it("a MANAGE_ROLES holder with only @everyone (top 0) can manage no role at all", async () => {
    const s = await setup();
    await setEveryone(s.guild.id, DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_ROLES);
    expect(await status("POST", `${s.base}/roles`, s.plain.token, { name: "x" })).toBe(403);
    expect(await status("PATCH", roleUrl(s, s.guild.id), s.plain.token, { permissions: 0 })).toBe(403);
    expect(await status("PUT", `/channels/${s.general.id}/overwrites/${s.guild.id}`, s.plain.token, { allow: 0, deny: P.SEND_MESSAGES })).toBe(403);
  });

  it("creating a role then assigning it to oneself gains nothing new", async () => {
    const s = await setup(P.MANAGE_ROLES | P.MANAGE_MESSAGES);
    const res = await call("POST", `${s.base}/roles`, s.mod.token, { name: "mine", permissions: P.MANAGE_MESSAGES });
    expect(res.statusCode).toBe(201);
    expect(res.json().position).toBe(1);
    expect(await status("PUT", assignUrl(s, s.mod.id, res.json().id), s.mod.token)).toBe(204);
    expect(await status("PUT", assignUrl(s, s.mod.id, res.json().id), s.mod.token)).toBe(204); // idempotent
    // the shifted mod role is still its top and still out of its own reach
    expect(await status("PATCH", roleUrl(s, s.roles.mod.id), s.mod.token, { permissions: P.ADMINISTRATOR })).toBe(403);
  });

  it("a role whose overwrite opens a channel the manager cannot see cannot be handed out", async () => {
    const s = await setup();
    const secret = (await call("POST", `${s.base}/channels`, s.owner.token, { name: "secret", type: "TEXT" })).json();
    await call("PUT", `/channels/${secret.id}/overwrites/${s.guild.id}`, s.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    await call("PUT", `/channels/${secret.id}/overwrites/${s.roles.below.id}`, s.owner.token, { allow: P.VIEW_CHANNEL, deny: 0 });
    expect(await status("PUT", assignUrl(s, s.mod.id, s.roles.below.id), s.mod.token)).toBe(403);
    expect(await status("PUT", assignUrl(s, s.plain.id, s.roles.below.id), s.mod.token)).toBe(403);
    expect(await status("DELETE", roleUrl(s, s.roles.below.id), s.mod.token)).toBe(403);
    expect(await status("PUT", assignUrl(s, s.plain.id, s.roles.below.id), s.owner.token)).toBe(204);
  });

  it("lifting a deny counts as granting: no SEND here means the @everyone SEND deny stays", async () => {
    const s = await setup(P.MANAGE_ROLES | P.VIEW_CHANNEL);
    await call("PUT", `/channels/${s.general.id}/overwrites/${s.guild.id}`, s.owner.token, { allow: 0, deny: P.SEND_MESSAGES });
    expect(await status("DELETE", `/channels/${s.general.id}/overwrites/${s.guild.id}`, s.mod.token)).toBe(403);
    expect(await status("PUT", `/channels/${s.general.id}/overwrites/${s.guild.id}`, s.mod.token, { allow: 0, deny: 0 })).toBe(403);
    expect(await status("POST", `/channels/${s.general.id}/messages`, s.plain.token, { content: "x" })).toBe(403);
  });

  it("overwrites obey the hierarchy too", async () => {
    const s = await setup(P.MANAGE_ROLES | DEFAULT_EVERYONE_PERMISSIONS);
    const url = (roleId: string) => `/channels/${s.general.id}/overwrites/${roleId}`;
    expect(await status("PUT", url(s.roles.above.id), s.mod.token, { allow: P.SEND_MESSAGES, deny: 0 })).toBe(403);
    expect(await status("PUT", url(s.roles.equal.id), s.mod.token, { allow: 0, deny: P.SEND_MESSAGES })).toBe(403);
    expect(await status("PUT", url(s.roles.below.id), s.mod.token, { allow: 0, deny: P.SEND_MESSAGES })).toBe(200);
    expect(await status("PUT", url(s.guild.id), s.mod.token, { allow: 0, deny: P.SEND_MESSAGES })).toBe(200);
  });

  it("ADMINISTRATOR passes permission checks but not the hierarchy", async () => {
    const s = await setup(P.ADMINISTRATOR);
    expect(await status("PATCH", roleUrl(s, s.roles.above.id), s.mod.token, { name: "x" })).toBe(403);
    expect(await status("PATCH", roleUrl(s, s.roles.equal.id), s.mod.token, { name: "x" })).toBe(403);
    expect(await status("PUT", assignUrl(s, s.mod.id, s.roles.above.id), s.mod.token)).toBe(403);
    expect(await status("DELETE", `${s.base}/members/${s.owner.id}`, s.mod.token)).toBe(403);
    expect(await status("DELETE", `${s.base}/members/${s.peer.id}`, s.mod.token)).toBe(403);
    expect(await status("PATCH", roleUrl(s, s.roles.below.id), s.mod.token, { permissions: P.ADMINISTRATOR })).toBe(200);
    expect(await status("DELETE", `${s.base}/members/${s.low.id}`, s.mod.token)).toBe(204);
  });

  it("kick: never the owner, never yourself, only members strictly below you", async () => {
    const s = await setup();
    expect(await status("DELETE", `${s.base}/members/${s.owner.id}`, s.mod.token)).toBe(403);
    expect(await status("DELETE", `${s.base}/members/${s.mod.id}`, s.mod.token)).toBe(400);
    expect(await status("DELETE", `${s.base}/members/${s.owner.id}`, s.owner.token)).toBe(400);
    expect(await status("DELETE", `${s.base}/members/${s.peer.id}`, s.mod.token)).toBe(403);
    expect(await status("DELETE", `${s.base}/members/00000000-0000-4000-8000-000000000000`, s.mod.token)).toBe(404);
    expect(await status("DELETE", `${s.base}/members/nope`, s.mod.token)).toBe(404);
    expect(await status("DELETE", `${s.base}/members/${s.plain.id}`, s.mod.token)).toBe(204);
    expect(await status("DELETE", `${s.base}/members/${s.low.id}`, s.low.token)).toBe(403); // no KICK_MEMBERS
  });

  it("nobody else can strip the owner's roles; the owner can do all of it", async () => {
    const s = await setup();
    await makeRole(s.guild.id, 1, 0, [s.owner.id]).then((r) =>
      call("DELETE", assignUrl(s, s.owner.id, r.id), s.mod.token).then((res) => expect(res.statusCode).toBe(403)),
    );
    const admin = (await call("POST", `${s.base}/roles`, s.owner.token, { name: "admin", permissions: P.ADMINISTRATOR })).json();
    expect(await status("PUT", assignUrl(s, s.plain.id, admin.id), s.owner.token)).toBe(204);
    expect(await status("PATCH", roleUrl(s, s.roles.above.id), s.owner.token, { permissions: P.KICK_MEMBERS })).toBe(200);
    expect(await status("DELETE", roleUrl(s, s.roles.above.id), s.owner.token)).toBe(204);
    expect(await status("DELETE", `${s.base}/members/${s.mod.id}`, s.owner.token)).toBe(204);
  });
});

describe("private channels", () => {
  async function privateSetup() {
    const s = await setup();
    const secret = (await call("POST", `${s.base}/channels`, s.owner.token, { name: "secret", type: "TEXT" })).json();
    await call("PUT", `/channels/${secret.id}/overwrites/${s.guild.id}`, s.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    await call("PUT", `/channels/${secret.id}/overwrites/${s.roles.below.id}`, s.owner.token, { allow: P.VIEW_CHANNEL, deny: 0 });
    return { ...s, secret, url: `/channels/${secret.id}/messages` };
  }
  const channelNames = async (s: S, token: string) =>
    (await call("GET", s.base, token)).json().channels.map((c: { name: string }) => c.name);

  it("invisible to members without access: absent from the guild, 404 like an unknown id", async () => {
    const s = await privateSetup();
    expect(await channelNames(s, s.plain.token)).toEqual(["general"]);
    const unknown = await call("GET", "/channels/00000000-0000-4000-8000-000000000000/messages", s.plain.token);
    const hidden = await call("GET", s.url, s.plain.token);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(unknown.body);
    expect(await status("POST", s.url, s.plain.token, { content: "x" })).toBe(404);
    expect(await status("DELETE", `${s.base}/channels/${s.secret.id}`, s.plain.token)).toBe(404);
  });

  it("visible to holders of the allowed role, and to the owner", async () => {
    const s = await privateSetup();
    expect(await channelNames(s, s.low.token)).toEqual(["general", "secret"]);
    expect(await channelNames(s, s.owner.token)).toEqual(["general", "secret"]);
    expect(await status("POST", s.url, s.low.token, { content: "x" })).toBe(201);
    const listed = (await call("GET", s.base, s.low.token)).json().channels[1];
    expect(listed.overwrites).toHaveLength(2); // the client needs them to run computePermissions
  });

  it("SEND denied by an overwrite: 403 to send, history still readable; a role allow beats it", async () => {
    const s = await setup();
    const url = `/channels/${s.general.id}/messages`;
    await call("PUT", `/channels/${s.general.id}/overwrites/${s.guild.id}`, s.owner.token, { allow: 0, deny: P.SEND_MESSAGES });
    expect(await status("POST", url, s.plain.token, { content: "x" })).toBe(403);
    expect(await status("GET", url, s.plain.token)).toBe(200);
    await call("PUT", `/channels/${s.general.id}/overwrites/${s.roles.below.id}`, s.owner.token, { allow: P.SEND_MESSAGES, deny: 0 });
    expect(await status("POST", url, s.low.token, { content: "x" })).toBe(201);
  });
});

describe("messages", () => {
  it("MANAGE_MESSAGES deletes others' messages; a plain member cannot; the author still can", async () => {
    const s = await setup(P.MANAGE_MESSAGES | DEFAULT_EVERYONE_PERMISSIONS);
    const url = `/channels/${s.general.id}/messages`;
    const [a, b] = [(await call("POST", url, s.plain.token, { content: "a" })).json(), (await call("POST", url, s.plain.token, { content: "b" })).json()];
    expect(await status("DELETE", `/messages/${a.id}`, s.low.token)).toBe(403);
    expect(await status("DELETE", `/messages/${a.id}`, s.mod.token)).toBe(204);
    expect(await status("DELETE", `/messages/${b.id}`, s.plain.token)).toBe(204);
  });

  it("an author who lost VIEW can no longer edit or delete their old messages (404)", async () => {
    const s = await setup();
    const url = `/channels/${s.general.id}/messages`;
    const msg = (await call("POST", url, s.plain.token, { content: "mine" })).json();
    await call("PUT", `/channels/${s.general.id}/overwrites/${s.guild.id}`, s.owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    expect(await status("PATCH", `/messages/${msg.id}`, s.plain.token, { content: "x" })).toBe(404);
    expect(await status("DELETE", `/messages/${msg.id}`, s.plain.token)).toBe(404);
  });
});

describe("ownership transfer", () => {
  it("hands the guild over; the old owner becomes a plain member who can leave; the new one can delete", async () => {
    const s = await setup();
    expect(await status("DELETE", `${s.base}/members/me`, s.owner.token)).toBe(409);
    const res = await call("POST", `${s.base}/transfer`, s.owner.token, { userId: s.plain.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().guild.ownerId).toBe(s.plain.id);
    expect(await status("DELETE", s.base, s.owner.token)).toBe(403);
    expect(await status("POST", `${s.base}/transfer`, s.owner.token, { userId: s.mod.id })).toBe(403);
    expect(await status("DELETE", `${s.base}/members/me`, s.owner.token)).toBe(204);
    expect(await status("DELETE", `${s.base}/members/me`, s.plain.token)).toBe(409);
    expect(await status("DELETE", s.base, s.plain.token)).toBe(204);
  });

  it("rejects non-owners, non-members, self and bad bodies", async () => {
    const s = await setup(P.ADMINISTRATOR);
    const outsider = await signUp(app, "outsider");
    expect(await status("POST", `${s.base}/transfer`, s.mod.token, { userId: s.mod.id })).toBe(403);
    expect(await status("POST", `${s.base}/transfer`, s.owner.token, { userId: outsider.id })).toBe(404);
    expect(await status("POST", `${s.base}/transfer`, s.owner.token, { userId: s.owner.id })).toBe(400);
    expect(await status("POST", `${s.base}/transfer`, s.owner.token, { userId: "nope" })).toBe(400);
    expect(await status("POST", `${s.base}/transfer`, outsider.token, { userId: s.mod.id })).toBe(404);
    expect((await prisma.guild.findUniqueOrThrow({ where: { id: s.guild.id } })).ownerId).toBe(s.owner.id);
  });

  it("two concurrent transfers: exactly one wins", async () => {
    const s = await setup();
    const targets = [s.mod, s.peer, s.low, s.plain];
    const codes = (
      await Promise.all(targets.map((t) => call("POST", `${s.base}/transfer`, s.owner.token, { userId: t.id })))
    ).map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 403)).toHaveLength(3);
    const winner = targets[codes.indexOf(200)]!;
    expect((await prisma.guild.findUniqueOrThrow({ where: { id: s.guild.id } })).ownerId).toBe(winner.id);
  });
});

describe("database invariants", () => {
  it("the migration backfills @everyone for guilds that predate roles", async () => {
    const owner = await signUp(app, "owner");
    const { guild: kept } = await guildWith(app, owner);
    await prisma.role.update({ where: { id: kept.id }, data: { permissions: 0 } });
    // a guild as it existed before step 5: no roles at all
    const old = await prisma.guild.create({ data: { name: "old", ownerId: owner.id, members: { create: { userId: owner.id } } } });
    const sql = readFileSync(new URL("../../prisma/migrations/20261010060000_roles/migration.sql", import.meta.url), "utf8");
    const backfill = sql.match(/^INSERT INTO "Role".*$/m)![0];
    await prisma.$executeRawUnsafe(backfill);
    const everyone = await prisma.role.findMany({ where: { position: 0 }, orderBy: { name: "asc" } });
    expect(everyone).toHaveLength(2);
    expect(await prisma.role.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      guildId: old.id, name: "@everyone", position: 0, permissions: DEFAULT_EVERYONE_PERMISSIONS,
    });
    expect((await prisma.role.findUniqueOrThrow({ where: { id: kept.id } })).permissions).toBe(0); // untouched
    expect(await status("GET", `/guilds/${old.id}`, owner.token)).toBe(200);
  });

  it("rejects a second position-0 role, assigning @everyone, and cross-guild assignments", async () => {
    const [owner, other] = await Promise.all([signUp(app, "owner"), signUp(app, "other")]);
    const { guild } = await guildWith(app, owner);
    const { guild: foreign } = await guildWith(app, other);
    const foreignRole = await makeRole(foreign.id, 1);
    await expect(prisma.role.create({ data: { guildId: guild.id, name: "fake", permissions: 0, position: 0 } })).rejects.toThrow();
    await expect(prisma.memberRole.create({ data: { guildId: guild.id, userId: owner.id, roleId: guild.id } })).rejects.toThrow();
    await expect(prisma.memberRole.create({ data: { guildId: guild.id, userId: owner.id, roleId: foreignRole.id } })).rejects.toThrow();
    expect(await status("PUT", `/guilds/${guild.id}/members/${owner.id}/roles/${foreignRole.id}`, owner.token)).toBe(404);
  });
});
