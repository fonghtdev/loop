import { MAX_BOTS_PER_USER } from "@loop/shared";
import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, resetDb, signUp } from "../../test/helpers.js";
import { connect, listen, until } from "../../test/sockets.js";
import { addVoiceChannel, decodeToken, disconnectAll, eventually, expectInRoom, identities, joinAs, requestToken } from "../../test/voice.js";
import { voiceRoom } from "../voice/rooms.js";

const app = buildApp(env);
const call = caller(app);

const createBot = async (owner: { token: string }, name = "helper_bot") => call("POST", "/bots", owner.token, { name });
const botLogin = (token: string) => call("POST", "/auth/bot-login", undefined, { token });
/** A bot of `owner`, logged in: `{id, name, token}` usable like a signed-up user, plus its raw `botToken`. */
async function makeBot(owner: { token: string }, name = "helper_bot") {
  const { bot, token: botToken } = (await createBot(owner, name)).json();
  const login = (await botLogin(botToken)).json();
  return { id: bot.id as string, name, token: login.accessToken as string, botToken: botToken as string };
}
const me = (token: string) => call("GET", "/me", token);

const sockets: Socket[] = [];
beforeEach(resetDb);
afterEach(async () => {
  await disconnectAll();
  sockets.splice(0).forEach((s) => s.close());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("creating and listing bots", () => {
  it("returns the raw token once; the DB holds only its hash and GET /bots never shows it", async () => {
    const owner = await signUp(app, "owner");
    const res = await createBot(owner);
    expect(res.statusCode).toBe(201);
    const { bot, token } = res.json();
    expect(bot).toEqual({ id: expect.any(String), username: "helper_bot", createdAt: expect.any(String) });
    expect(token).toMatch(new RegExp(`^${bot.id}\\.[A-Za-z0-9_-]{43}$`));
    const secret = token.split(".")[1];
    const row = await prisma.user.findUniqueOrThrow({ where: { id: bot.id } });
    expect(row).toMatchObject({ isBot: true, ownerId: owner.id, email: `bot-${bot.id}@bots.invalid`, passwordHash: "!" });
    expect(JSON.stringify(row)).not.toContain(secret);
    const list = await call("GET", "/bots", owner.token);
    expect(list.json()).toEqual([bot]);
    expect(list.body).not.toContain(secret);
  });

  it("a bot name follows the username rules and cannot take a person's (or another bot's) name", async () => {
    const owner = await signUp(app, "owner");
    expect((await createBot(owner, "Bad Name")).statusCode).toBe(400);
    expect((await createBot(owner, "owner")).statusCode).toBe(409);
    expect((await createBot(owner, "taken_bot")).statusCode).toBe(201);
    expect((await createBot(owner, "taken_bot")).statusCode).toBe(409);
    // and a person cannot register the bot's name
    const reg = await call("POST", "/auth/register", undefined, { email: "x@example.com", username: "taken_bot", password: "correct-horse" });
    expect(reg.statusCode).toBe(409);
  });

  it(`caps live bots at ${MAX_BOTS_PER_USER} per owner, also under concurrent creates; deleting frees a slot`, async () => {
    const owner = await signUp(app, "owner");
    const results = await Promise.all(Array.from({ length: MAX_BOTS_PER_USER + 2 }, (_, i) => createBot(owner, `bot_${i}`)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(MAX_BOTS_PER_USER);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2);
    const [first] = (await call("GET", "/bots", owner.token)).json();
    expect((await call("DELETE", `/bots/${first.id}`, owner.token)).statusCode).toBe(204);
    expect((await createBot(owner, "bot_again")).statusCode).toBe(201);
  });

  it("a bot cannot create bots nor call any bot management route", async () => {
    const owner = await signUp(app, "owner");
    const bot = await makeBot(owner);
    expect((await createBot(bot, "child_bot")).statusCode).toBe(403);
    expect((await call("GET", "/bots", bot.token)).statusCode).toBe(403);
    expect((await call("POST", `/bots/${bot.id}/token`, bot.token)).statusCode).toBe(403);
    expect((await call("DELETE", `/bots/${bot.id}`, bot.token)).statusCode).toBe(403);
    expect(await prisma.user.count({ where: { isBot: true } })).toBe(1);
  });

  it("401 without a user", async () => {
    expect((await call("POST", "/bots", undefined, { name: "x_bot" })).statusCode).toBe(401);
    expect((await call("GET", "/bots")).statusCode).toBe(401);
  });
});

describe("POST /auth/bot-login", () => {
  it("the right token gives an access token that works on REST", async () => {
    const owner = await signUp(app, "owner");
    const { bot, token } = (await createBot(owner)).json();
    const res = await botLogin(token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toEqual({ id: bot.id, email: `bot-${bot.id}@bots.invalid`, username: "helper_bot" });
    expect(body.refreshToken).toBeUndefined();
    expect((await me(body.accessToken)).json()).toMatchObject({ id: bot.id, username: "helper_bot" });
  });

  it("every wrong token is the same 401", async () => {
    const owner = await signUp(app, "owner");
    const { bot, token } = (await createBot(owner)).json();
    const { token: other } = (await createBot(owner, "other_bot")).json();
    const [id, secret] = token.split(".");
    const flipped = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
    const wrong = [
      `${id}.${flipped}`, // one character changed
      `${id}.${other.split(".")[1]}`, // another bot's secret
      `${other.split(".")[0]}.${secret}`, // another bot's id
      `${id}.`, // empty secret
      id, // no secret at all
      `.${secret}`,
      `not-a-uuid.${secret}`,
      `6f1d1f0e-0000-4000-8000-000000000000.${secret}`, // unknown id
    ];
    for (const t of wrong) {
      const res = await botLogin(t);
      expect(res.statusCode, t).toBe(401);
      expect(res.json()).toEqual({ error: "Invalid bot token" });
    }
    expect((await botLogin("")).statusCode).toBe(400);
    expect(bot.id).toBe(id);
  });

  it("an empty secret never logs in, even against a bot whose stored hash is the hash of the empty string", async () => {
    const owner = await signUp(app, "owner");
    const bot = await makeBot(owner);
    await prisma.user.update({ where: { id: bot.id }, data: { botTokenHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" } });
    expect((await botLogin(`${bot.id}.`)).statusCode).toBe(401);
  });

  it("a deleted bot cannot log in", async () => {
    const owner = await signUp(app, "owner");
    const bot = await makeBot(owner);
    await call("DELETE", `/bots/${bot.id}`, owner.token);
    expect((await botLogin(bot.botToken)).statusCode).toBe(401);
  });

  it("a bot cannot log in with a password, and its synthetic email cannot be registered", async () => {
    const owner = await signUp(app, "owner");
    const bot = await makeBot(owner);
    const email = `bot-${bot.id}@bots.invalid`;
    for (const password of ["!", "", "correct-horse"]) {
      expect((await call("POST", "/auth/login", undefined, { email, password })).statusCode).toBe(401);
    }
    const reg = await call("POST", "/auth/register", undefined, { email: email.toUpperCase(), username: "squatter", password: "correct-horse" });
    expect(reg.statusCode).toBe(409);
    expect(await prisma.session.count()).toBe(1); // only the owner's own sign-up session
  });
});

describe("rotating and deleting", () => {
  it("rotation kills the old token, live access tokens, sockets and voice sessions at once; the new token works", async () => {
    const owner = await signUp(app, "owner");
    const bot = await makeBot(owner);
    const { guild } = await guildWith(app, owner, bot);
    const voice = await addVoiceChannel(app, owner, guild.id);
    await joinAs((await requestToken(app, bot, voice.id)).json());
    await expectInRoom(voiceRoom(voice.id), [bot.id]);
    const port = await listen(app);
    const socket = await connect(port, bot.token, [], sockets);
    const res = await call("POST", `/bots/${bot.id}/token`, owner.token);
    expect(res.statusCode).toBe(200);
    const { token } = res.json();
    expect(token).not.toBe(bot.botToken);
    expect((await botLogin(bot.botToken)).statusCode).toBe(401);
    expect((await me(bot.token)).statusCode).toBe(401);
    await until(() => socket.disconnected);
    await expect(connect(port, bot.token, [], sockets)).rejects.toThrow("Unauthorized");
    await eventually(async () => expect(await identities(voiceRoom(voice.id))).toEqual([]));
    const fresh = (await botLogin(token)).json().accessToken;
    expect((await me(fresh)).statusCode).toBe(200);
  });

  it("someone else's bot is a 404 for rotate and delete, and stays untouched", async () => {
    const [owner, other] = await Promise.all([signUp(app, "owner"), signUp(app, "other")]);
    const bot = await makeBot(owner);
    for (const id of [bot.id, "not-a-uuid", "6f1d1f0e-0000-4000-8000-000000000000"]) {
      expect((await call("POST", `/bots/${id}/token`, other.token)).statusCode).toBe(404);
      expect((await call("DELETE", `/bots/${id}`, other.token)).statusCode).toBe(404);
    }
    expect((await call("GET", "/bots", other.token)).json()).toEqual([]);
    expect((await me(bot.token)).statusCode).toBe(200);
    expect((await botLogin(bot.botToken)).statusCode).toBe(200);
  });

  it("deleting leaves its guilds and voice, kills its tokens, keeps its messages; the bot is gone from GET /bots", async () => {
    const owner = await signUp(app, "owner");
    const bot = await makeBot(owner);
    const { guild, general } = await guildWith(app, owner, bot);
    const voice = await addVoiceChannel(app, owner, guild.id);
    await joinAs((await requestToken(app, bot, voice.id)).json());
    await expectInRoom(voiceRoom(voice.id), [bot.id]);
    await call("POST", `/channels/${general.id}/messages`, bot.token, { content: "beep" });

    expect((await call("DELETE", `/bots/${bot.id}`, owner.token)).statusCode).toBe(204);
    expect((await me(bot.token)).statusCode).toBe(401);
    expect((await call("GET", "/bots", owner.token)).json()).toEqual([]);
    expect((await call("GET", `/guilds/${guild.id}/members`, owner.token)).json().map((m: { userId: string }) => m.userId)).toEqual([owner.id]);
    await eventually(async () => expect(await identities(voiceRoom(voice.id))).toEqual([]));
    const { messages } = (await call("GET", `/channels/${general.id}/messages`, owner.token)).json();
    expect(messages[0].author).toEqual({ id: bot.id, username: "helper_bot", isBot: true });
    expect((await call("DELETE", `/bots/${bot.id}`, owner.token)).statusCode).toBe(404);
  });

  it("a bot that owns a guild cannot be deleted until it gives the guild away", async () => {
    const owner = await signUp(app, "owner");
    const bot = await makeBot(owner);
    await call("POST", "/guilds", bot.token, { name: "Bot HQ" });
    expect((await call("DELETE", `/bots/${bot.id}`, owner.token)).statusCode).toBe(409);
    expect((await me(bot.token)).statusCode).toBe(200);
  });
});

describe("a bot uses the normal routes", () => {
  it("joins by invite, sends a message (author flagged isBot), shows as a bot in the member list, gets a LiveKit token", async () => {
    const owner = await signUp(app, "owner");
    const bot = await makeBot(owner);
    const { guild, general } = await guildWith(app, owner, bot);
    const members = (await call("GET", `/guilds/${guild.id}/members`, owner.token)).json();
    expect(members.map((m: { username: string; isBot: boolean }) => [m.username, m.isBot])).toEqual([["owner", false], ["helper_bot", true]]);
    const sent = await call("POST", `/channels/${general.id}/messages`, bot.token, { content: "hello humans" });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().author).toEqual({ id: bot.id, username: "helper_bot", isBot: true });
    const voice = await addVoiceChannel(app, owner, guild.id);
    const res = await requestToken(app, bot, voice.id);
    expect(res.statusCode).toBe(200);
    expect((await decodeToken(res.json().token)).sub).toBe(bot.id);
  });

  it("a bot neither sends nor receives friend requests (so no DMs or DM calls either)", async () => {
    const [owner, alice] = await Promise.all([signUp(app, "owner"), signUp(app, "alice")]);
    const bot = await makeBot(owner);
    expect((await call("POST", "/friends/requests", bot.token, { username: "alice" })).statusCode).toBe(403);
    expect((await call("POST", "/friends/requests", alice.token, { username: bot.name })).statusCode).toBe(403);
    expect(await prisma.friendship.count()).toBe(0);
    expect((await call("POST", "/dms", alice.token, { userId: bot.id })).statusCode).toBe(404);
  });
});
