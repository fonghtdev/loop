import { randomUUID } from "node:crypto";
import { Permission as P } from "@loop/shared";
import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { sweepStaleProfileUploads } from "./images.js";
import { befriend, caller, env, guildWith, JPEG, makeRole, PNG, resetDb, signUp as signUpUser, testStorage, uploadImage } from "../../test/helpers.js";
import { connect as connectTo, listen, settle, until } from "../../test/sockets.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
const EVENTS = ["user:updated", "guild:updated", "channel:updated"];
let port: number;
const sockets: Socket[] = [];
const connect = (u: { token: string }) => connectTo(port, u.token, EVENTS, sockets);
const profile = (viewer: { token: string }, id: string) => call("GET", `/users/${id}/profile`, viewer.token);

beforeAll(async () => {
  port = await listen(app);
});
beforeEach(resetDb);
afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("GET /users/:userId/profile visibility", () => {
  it("shows the profile to the user, friends and people in a shared guild", async () => {
    const [me, friend, mate, stranger] = await Promise.all(["me", "friend", "mate", "stranger"].map(signUp));
    await befriend(app, me, friend);
    await guildWith(app, me, mate);
    await call("PATCH", "/me/profile", me.token, { displayName: "Moi", bio: "hello", statusText: "busy" });
    for (const viewer of [me, friend, mate]) {
      const res = await profile(viewer, me.id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: me.id, username: "me", displayName: "Moi", bio: "hello", statusText: "busy", avatarHash: null, bannerHash: null });
      expect(res.json().createdAt).toBeTruthy();
      expect(res.json()).not.toHaveProperty("email");
    }
    expect((await profile(stranger, me.id)).statusCode).toBe(404);
  });

  it("answers a stranger, a block (either way, even in a shared guild) and an unknown id with the same 404", async () => {
    const [a, b, c] = await Promise.all(["alice", "bob", "carol"].map(signUp));
    await guildWith(app, a, b, c);
    await call("PUT", `/blocks/${b.id}`, a.token);
    const unknown = await profile(a, randomUUID());
    expect(unknown.statusCode).toBe(404);
    for (const [viewer, target] of [[a, b], [b, a]] as const) {
      const res = await profile(viewer, target.id);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(unknown.body);
    }
    expect((await profile(a, c.id)).statusCode, "an unblocked co-member is fine").toBe(200);
    expect((await profile(a, "not-a-uuid")).body).toBe(unknown.body);
    expect((await call("GET", `/users/${a.id}/profile`)).statusCode).toBe(401);
  });
});

describe("PATCH /me/profile", () => {
  it("updates only the given keys, trims, and null clears", async () => {
    const me = await signUp("me");
    expect((await call("PATCH", "/me/profile", me.token, { displayName: "  Moi  ", bio: "line1\nline2", statusText: "x" })).json()).toMatchObject({
      displayName: "Moi", bio: "line1\nline2", statusText: "x", username: "me",
    });
    const second = (await call("PATCH", "/me/profile", me.token, { statusText: null, bio: "   " })).json();
    expect(second).toMatchObject({ displayName: "Moi", bio: null, statusText: null });
  });

  it.each([
    ["unknown key", { username: "other" }],
    ["empty body", {}],
    ["blank display name", { displayName: "   " }],
    ["33-character display name", { displayName: "x".repeat(33) }],
    ["control character in the name", { displayName: "a\u0000b" }],
    ["newline in the name", { displayName: "a\nb" }],
    ["bidi override in the name", { displayName: "a‮b" }],
    ["bidi isolate in the status", { statusText: "a⁦b" }],
    ["191-character bio", { bio: "x".repeat(191) }],
    ["129-character status", { statusText: "x".repeat(129) }],
    ["NUL in the bio", { bio: "a\u0000b" }],
    ["wrong type", { bio: 5 }],
  ])("rejects %s with 400", async (_, body) => {
    const me = await signUp("me");
    expect((await call("PATCH", "/me/profile", me.token, body)).statusCode).toBe(400);
    expect((await profile(me, me.id)).json()).toMatchObject({ displayName: null, bio: null, statusText: null });
  });

  it("accepts the maximum lengths (counted in characters) and keeps names non-unique", async () => {
    const [a, b] = await Promise.all(["alice", "bob"].map(signUp));
    const name = "😀".repeat(32);
    expect((await call("PATCH", "/me/profile", a.token, { displayName: name, bio: "é".repeat(190), statusText: "x".repeat(128) })).statusCode).toBe(200);
    expect((await call("PATCH", "/me/profile", b.token, { displayName: name })).statusCode).toBe(200);
  });

  it("the database enforces the lengths too", async () => {
    const me = await signUp("me");
    await guildWith(app, me);
    await expect(prisma.$executeRaw`UPDATE "User" SET "bio" = ${"x".repeat(191)} WHERE id = ${me.id}::uuid`).rejects.toThrow(/User_bio_check/);
    await expect(prisma.$executeRaw`UPDATE "User" SET "displayName" = '' WHERE id = ${me.id}::uuid`).rejects.toThrow(/User_displayName_check/);
    await expect(prisma.$executeRaw`UPDATE "Channel" SET "topic" = ${"x".repeat(1025)}`).rejects.toThrow();
  });
});

describe("public fields travel with users", () => {
  it("displayName and avatarHash are in author, members, friends, dms, blocks, /me, login and member:joined; bio and statusText are not", async () => {
    const [me, friend, other] = await Promise.all(["me", "friend", "other"].map(signUp));
    await befriend(app, me, friend);
    const { guild, general } = await guildWith(app, me, friend);
    await call("PATCH", "/me/profile", me.token, { displayName: "Moi", bio: "secret bio", statusText: "secret status" });
    await prisma.user.update({ where: { id: me.id }, data: { avatarHash: "abc123" } });
    const expected = { displayName: "Moi", avatarHash: "abc123" };
    const msg = await call("POST", `/channels/${general.id}/messages`, me.token, { content: "hi" });
    expect(msg.json().author).toMatchObject({ id: me.id, ...expected });
    const history = (await call("GET", `/channels/${general.id}/messages`, friend.token)).json();
    expect(history.messages[0].author).toMatchObject(expected);
    const members = (await call("GET", `/guilds/${guild.id}/members`, friend.token)).json();
    expect(members.find((m: { userId: string }) => m.userId === me.id)).toMatchObject(expected);
    expect((await call("GET", "/friends", friend.token)).json().friends[0]).toMatchObject(expected);
    await call("POST", "/dms", friend.token, { userId: me.id });
    expect((await call("GET", "/dms", friend.token)).json()[0].user).toMatchObject(expected);
    await call("PUT", `/blocks/${me.id}`, other.token);
    expect((await call("GET", "/blocks", other.token)).json()[0]).toMatchObject({ id: me.id, ...expected });
    expect((await call("GET", "/me", me.token)).json()).toMatchObject({ id: me.id, username: "me", ...expected });
    const login = await call("POST", "/auth/login", undefined, { email: "me@example.com", password: "correct-horse" });
    expect(login.json().user).toMatchObject(expected);
    const everything = JSON.stringify([members, history, (await call("GET", "/friends", friend.token)).json(), (await call("GET", "/dms", friend.token)).json()]);
    expect(everything).not.toContain("secret");
  });
});

describe("user:updated", () => {
  it("reaches the user, friends and co-members, never strangers or blocked users", async () => {
    const [me, friend, mate, blocked, stranger] = await Promise.all(["me", "friend", "mate", "blocked", "stranger"].map(signUp));
    await befriend(app, me, friend);
    await guildWith(app, me, mate, blocked);
    await call("PUT", `/blocks/${blocked.id}`, me.token);
    const [sMe, sFriend, sMate, sBlocked, sStranger] = await Promise.all([me, friend, mate, blocked, stranger].map(connect));
    await settle();
    await call("PATCH", "/me/profile", me.token, { displayName: "Moi", statusText: "hi", bio: "private" });
    const event = { id: me.id, username: "me", displayName: "Moi", avatarHash: null, bannerHash: null, statusText: "hi" };
    await until(() => sMe.got["user:updated"]!.length && sFriend.got["user:updated"]!.length && sMate.got["user:updated"]!.length);
    for (const s of [sMe, sFriend, sMate]) expect(s.got["user:updated"]).toEqual([event]);
    await settle();
    expect(sBlocked.got["user:updated"]).toEqual([]);
    expect(sStranger.got["user:updated"]).toEqual([]);
  });
});

describe("PATCH /guilds/:guildId", () => {
  it("the owner and administrators rename; members get 403, outsiders 404", async () => {
    const [owner, admin, member, outsider] = await Promise.all(["owner", "admin", "member", "outsider"].map(signUp));
    const { guild } = await guildWith(app, owner, admin, member);
    await makeRole(guild.id, 1, P.ADMINISTRATOR, [admin.id]);
    const patch = (u: { token: string }, name: string) => call("PATCH", `/guilds/${guild.id}`, u.token, { name });
    expect((await patch(member, "x")).statusCode).toBe(403);
    expect((await patch(outsider, "x")).statusCode).toBe(404);
    expect((await patch(admin, "  By admin ")).json()).toMatchObject({ id: guild.id, name: "By admin", iconHash: null });
    expect((await patch(owner, "By owner")).statusCode).toBe(200);
    expect((await call("GET", "/guilds", member.token)).json()[0].name).toBe("By owner");
  });

  it("a user with only MANAGE_CHANNELS cannot rename the guild", async () => {
    const [owner, mod] = await Promise.all(["owner", "mod"].map(signUp));
    const { guild } = await guildWith(app, owner, mod);
    await makeRole(guild.id, 1, P.MANAGE_CHANNELS | P.MANAGE_ROLES, [mod.id]);
    expect((await call("PATCH", `/guilds/${guild.id}`, mod.token, { name: "x" })).statusCode).toBe(403);
  });

  it.each([["empty name", { name: "" }], ["101 characters", { name: "x".repeat(101) }], ["unknown key", { name: "ok", ownerId: "x" }], ["empty body", {}]])("rejects %s with 400", async (_, body) => {
    const owner = await signUp("owner");
    const { guild } = await guildWith(app, owner);
    expect((await call("PATCH", `/guilds/${guild.id}`, owner.token, body)).statusCode).toBe(400);
  });

  it("emits guild:updated to every member and nobody else", async () => {
    const [owner, member, outsider] = await Promise.all(["owner", "member", "outsider"].map(signUp));
    const { guild } = await guildWith(app, owner, member);
    const [sOwner, sMember, sOutsider] = await Promise.all([owner, member, outsider].map(connect));
    await call("PATCH", `/guilds/${guild.id}`, owner.token, { name: "Renamed" });
    await until(() => sOwner.got["guild:updated"]!.length && sMember.got["guild:updated"]!.length);
    expect(sMember.got["guild:updated"]).toEqual([{ id: guild.id, name: "Renamed", iconHash: null }]);
    await settle();
    expect(sOutsider.got["guild:updated"]).toEqual([]);
  });
});

describe("PATCH /channels/:channelId", () => {
  async function setup() {
    const [owner, mod, member] = await Promise.all(["owner", "mod", "member"].map(signUp));
    const { guild, general } = await guildWith(app, owner, mod, member);
    await makeRole(guild.id, 1, P.MANAGE_CHANNELS, [mod.id]);
    return { owner, mod, member, guild, general };
  }

  it("MANAGE_CHANNELS renames and sets the topic; null clears it; members get 403", async () => {
    const { mod, member, general } = await setup();
    expect((await call("PATCH", `/channels/${general.id}`, member.token, { topic: "x" })).statusCode).toBe(403);
    const res = await call("PATCH", `/channels/${general.id}`, mod.token, { name: "lobby", topic: " Welcome\nhome " });
    expect(res.json()).toMatchObject({ id: general.id, name: "lobby", topic: "Welcome\nhome" });
    expect((await call("PATCH", `/channels/${general.id}`, mod.token, { topic: null })).json()).toMatchObject({ name: "lobby", topic: null });
  });

  it("rejects bad input and duplicate names", async () => {
    const { owner, guild, general } = await setup();
    await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "taken", type: "TEXT" });
    const patch = (body: object) => call("PATCH", `/channels/${general.id}`, owner.token, body);
    expect((await patch({ name: "taken" })).statusCode).toBe(409);
    for (const bad of [{ name: "Has Space" }, { name: "" }, { topic: "x".repeat(1025) }, { topic: "a\u0000" }, { type: "VOICE" }, {}]) {
      expect((await patch(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch({ topic: "x".repeat(1024) })).statusCode).toBe(200);
    expect((await call("PATCH", `/channels/${randomUUID()}`, owner.token, { topic: "x" })).statusCode).toBe(404);
  });

  it("the channel JSON everywhere carries topic", async () => {
    const { owner, guild, general } = await setup();
    await call("PATCH", `/channels/${general.id}`, owner.token, { topic: "t" });
    expect((await call("GET", `/guilds/${guild.id}`, owner.token)).json().channels[0].topic).toBe("t");
  });

  it("emits channel:updated only to members who can see the channel", async () => {
    const { owner, mod, member, guild } = await setup();
    const secret = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "secret", type: "TEXT" })).json();
    await prisma.channelOverwrite.create({ data: { guildId: guild.id, channelId: secret.id, roleId: guild.id, allow: 0, deny: P.VIEW_CHANNEL } });
    const modRole = await prisma.role.findFirstOrThrow({ where: { guildId: guild.id, name: "role1" } });
    await prisma.channelOverwrite.create({ data: { guildId: guild.id, channelId: secret.id, roleId: modRole.id, allow: P.VIEW_CHANNEL, deny: 0 } });
    const [sOwner, sMod, sMember] = await Promise.all([owner, mod, member].map(connect));
    await call("PATCH", `/channels/${secret.id}`, owner.token, { topic: "shh" });
    await until(() => sOwner.got["channel:updated"]!.length && sMod.got["channel:updated"]!.length);
    expect(sMod.got["channel:updated"]).toEqual([expect.objectContaining({ id: secret.id, topic: "shh", name: "secret" })]);
    await settle();
    expect(sMember.got["channel:updated"]).toEqual([]);
  });
});

describe("avatar and banner uploads", () => {
  const read = (path: string) => app.inject({ method: "GET", url: path });

  it("stores a verified image, serves it through an unauthenticated 302, and exposes only the hash", async () => {
    const me = await signUp("me");
    const up = await uploadImage(app, me.token, "/me/avatar");
    expect(up.create.statusCode).toBe(201);
    expect(up.create.json().headers).toEqual({ "Content-Type": "image/png" });
    expect(up.complete.statusCode).toBe(200);
    const { hash } = up.complete.json();
    expect((await profile(me, me.id)).json().avatarHash).toBe(hash);
    const res = await read(`/users/${me.id}/avatar`);
    expect(res.statusCode).toBe(302);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.headers.location).toContain(`profile/${me.id}/avatar-${hash}`);
    const file = await fetch(res.headers.location as string);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("content-disposition")).toBe("inline");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
  });

  it("replacing deletes the previous object; DELETE clears and 404s the read", async () => {
    const me = await signUp("me");
    const first = (await uploadImage(app, me.token, "/me/avatar")).complete.json().hash;
    const second = (await uploadImage(app, me.token, "/me/avatar")).complete.json().hash;
    expect(second).not.toBe(first);
    expect(await testStorage.head(`profile/${me.id}/avatar-${first}`)).toBeNull();
    expect(await testStorage.head(`profile/${me.id}/avatar-${second}`)).not.toBeNull();
    expect((await call("DELETE", "/me/avatar", me.token)).statusCode).toBe(204);
    expect(await testStorage.head(`profile/${me.id}/avatar-${second}`)).toBeNull();
    expect((await read(`/users/${me.id}/avatar`)).statusCode).toBe(404);
    expect((await profile(me, me.id)).json().avatarHash).toBeNull();
  });

  it("the banner is separate from the avatar and allows 10 MB where the avatar allows 8", async () => {
    const me = await signUp("me");
    const big = 9 * 1024 * 1024;
    expect((await call("POST", "/me/avatar/upload", me.token, { contentType: "image/png", size: big })).statusCode).toBe(400);
    expect((await call("POST", "/me/banner/upload", me.token, { contentType: "image/png", size: big })).statusCode).toBe(201);
    expect((await call("POST", "/me/banner/upload", me.token, { contentType: "image/png", size: 11 * 1024 * 1024 })).statusCode).toBe(400);
    const { hash } = (await uploadImage(app, me.token, "/me/banner")).complete.json();
    const p = (await profile(me, me.id)).json();
    expect(p).toMatchObject({ bannerHash: hash, avatarHash: null });
    expect((await read(`/users/${me.id}/banner`)).statusCode).toBe(302);
    expect((await read(`/users/${me.id}/avatar`)).statusCode).toBe(404);
  });

  it.each([
    ["bytes of another type than declared", JPEG, undefined],
    ["a script declared as png", Buffer.from("<svg onload=alert(1)>"), undefined],
    ["a size that differs from the declared one", Buffer.from(PNG), { size: PNG.length + 5 }],
  ] as const)("rejects %s and leaves nothing", async (_, bytes, declared) => {
    const me = await signUp("me");
    const up = await uploadImage(app, me.token, "/me/avatar", bytes, declared);
    expect(up.complete.statusCode).toBe(400);
    expect(await testStorage.head(`profile-uploads/${up.id}`)).toBeNull();
    expect((await profile(me, me.id)).json().avatarHash).toBeNull();
    expect((await call("POST", "/me/avatar/complete", me.token, { id: up.id })).statusCode, "the row is gone").toBe(404);
  });

  it("refuses svg and other types at step 1", async () => {
    const me = await signUp("me");
    for (const contentType of ["image/svg+xml", "application/pdf", "text/html"]) {
      expect((await call("POST", "/me/avatar/upload", me.token, { contentType, size: 10 })).statusCode).toBe(400);
    }
    expect((await call("POST", "/me/avatar/upload", me.token, { contentType: "image/png", size: 10, extra: 1 })).statusCode).toBe(400);
  });

  it("only the uploader can complete; unknown, foreign, malformed and repeated ids are 404", async () => {
    const [me, other] = await Promise.all(["me", "other"].map(signUp));
    const create = (await call("POST", "/me/avatar/upload", me.token, { contentType: "image/png", size: PNG.length })).json();
    await fetch(create.uploadUrl, { method: "PUT", headers: create.headers, body: PNG });
    for (const id of [create.id, randomUUID(), "nope"]) {
      expect((await call("POST", "/me/avatar/complete", other.token, { id })).statusCode).toBe(404);
    }
    expect((await call("POST", "/me/avatar/complete", me.token, { id: randomUUID() })).statusCode).toBe(404);
    expect((await call("POST", "/me/banner/complete", me.token, { id: create.id })).statusCode, "wrong kind").toBe(404);
    expect((await call("POST", "/me/avatar/complete", me.token, { id: create.id })).statusCode).toBe(200);
    expect((await call("POST", "/me/avatar/complete", me.token, { id: create.id })).statusCode, "replay").toBe(404);
    expect((await profile(other, other.id)).json().avatarHash).toBeNull();
  });

  it("an expired pending upload is never served", async () => {
    const me = await signUp("me");
    const create = (await call("POST", "/me/avatar/upload", me.token, { contentType: "image/png", size: PNG.length })).json();
    await fetch(create.uploadUrl, { method: "PUT", headers: create.headers, body: PNG });
    await prisma.profileUpload.update({ where: { id: create.id }, data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) } });
    const res = await call("POST", "/me/avatar/complete", me.token, { id: create.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Upload expired");
    expect(await testStorage.head(`profile-uploads/${create.id}`)).toBeNull();
    expect((await read(`/users/${me.id}/avatar`)).statusCode).toBe(404);
  });

  it("a new upload request replaces the previous pending one, and the sweep removes stale ones", async () => {
    const me = await signUp("me");
    const one = (await call("POST", "/me/avatar/upload", me.token, { contentType: "image/png", size: PNG.length })).json();
    await fetch(one.uploadUrl, { method: "PUT", headers: one.headers, body: PNG });
    const two = (await call("POST", "/me/avatar/upload", me.token, { contentType: "image/png", size: PNG.length })).json();
    expect(await testStorage.head(`profile-uploads/${one.id}`)).toBeNull();
    expect(await prisma.profileUpload.count({ where: { userId: me.id } })).toBe(1);
    await fetch(two.uploadUrl, { method: "PUT", headers: two.headers, body: PNG });
    expect(await sweepStaleProfileUploads(testStorage, new Date(Date.now() - 1000))).toBe(0);
    expect(await sweepStaleProfileUploads(testStorage, new Date(Date.now() + 1000))).toBe(1);
    expect(await testStorage.head(`profile-uploads/${two.id}`)).toBeNull();
  });

  it("public reads give one uniform 404 and need no token", async () => {
    const [me, none] = await Promise.all(["me", "none"].map(signUp));
    await uploadImage(app, me.token, "/me/avatar");
    const misses = await Promise.all([`/users/${none.id}/avatar`, `/users/${randomUUID()}/avatar`, "/users/nope/avatar", `/users/${me.id}/banner`, `/guilds/${randomUUID()}/icon`, "/guilds/nope/icon"].map(read));
    expect(misses.map((r) => r.statusCode)).toEqual(Array(6).fill(404));
    expect(new Set(misses.map((r) => r.body)).size).toBe(1);
    expect((await read(`/users/${me.id}/avatar`)).statusCode).toBe(302);
  });

  it("a changed avatar is announced as user:updated with the new hash", async () => {
    const [me, friend] = await Promise.all(["me", "friend"].map(signUp));
    await befriend(app, me, friend);
    const sFriend = await connect(friend);
    await settle();
    const { hash } = (await uploadImage(app, me.token, "/me/avatar")).complete.json();
    await until(() => sFriend.got["user:updated"]!.length);
    expect(sFriend.got["user:updated"]![0]).toMatchObject({ id: me.id, avatarHash: hash });
    await call("DELETE", "/me/avatar", me.token);
    await until(() => sFriend.got["user:updated"]!.length === 2);
    expect(sFriend.got["user:updated"]![1].avatarHash).toBeNull();
  });
});

describe("guild icon", () => {
  it("owner and administrators set it; others get 403/404; it reaches guild payloads, members and guild:updated", async () => {
    const [owner, admin, member, outsider] = await Promise.all(["owner", "admin", "member", "outsider"].map(signUp));
    const { guild } = await guildWith(app, owner, admin, member);
    await makeRole(guild.id, 1, P.ADMINISTRATOR, [admin.id]);
    const base = `/guilds/${guild.id}/icon`;
    expect((await call("POST", `${base}/upload`, member.token, { contentType: "image/png", size: 10 })).statusCode).toBe(403);
    expect((await call("POST", `${base}/upload`, outsider.token, { contentType: "image/png", size: 10 })).statusCode).toBe(404);
    const sMember = await connect(member);
    const up = await uploadImage(app, admin.token, base);
    expect(up.complete.statusCode).toBe(200);
    const { hash } = up.complete.json();
    expect((await call("GET", "/guilds", member.token)).json()[0].iconHash).toBe(hash);
    expect((await call("GET", `/guilds/${guild.id}`, member.token)).json().guild.iconHash).toBe(hash);
    await until(() => sMember.got["guild:updated"]!.length);
    expect(sMember.got["guild:updated"]![0]).toEqual({ id: guild.id, name: "HQ", iconHash: hash });
    const res = await app.inject({ method: "GET", url: base });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`guilds/${guild.id}/icon-${hash}`);
    expect((await call("DELETE", base, member.token)).statusCode).toBe(403);
    expect((await call("DELETE", base, owner.token)).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(404);
  });

  it("a pending icon upload cannot be completed on another guild or by a user who lost the right", async () => {
    const [owner, admin] = await Promise.all(["owner", "admin"].map(signUp));
    const { guild } = await guildWith(app, owner, admin);
    const other = (await call("POST", "/guilds", owner.token, { name: "Other" })).json().guild;
    const role = await makeRole(guild.id, 1, P.ADMINISTRATOR, [admin.id]);
    const create = (await call("POST", `/guilds/${guild.id}/icon/upload`, admin.token, { contentType: "image/png", size: 67 })).json();
    expect((await call("POST", `/guilds/${other.id}/icon/complete`, owner.token, { id: create.id })).statusCode).toBe(404);
    await prisma.role.delete({ where: { id: role.id } });
    expect((await call("POST", `/guilds/${guild.id}/icon/complete`, admin.token, { id: create.id })).statusCode).toBe(403);
  });
});
