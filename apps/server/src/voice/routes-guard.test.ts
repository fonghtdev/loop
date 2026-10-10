import { DEFAULT_EVERYONE_PERMISSIONS, Permission as P } from "@loop/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, guildWith, isVoiceRoute, type Method, resetDb, setEveryone, signUp } from "../../test/helpers.js";
import { addVoiceChannel } from "../../test/voice.js";

/**
 * Every voice route and what it does to someone without access. A voice route missing from ROWS and from
 * ALLOWLIST fails the guard below, so a new route cannot ship without this decision. Each row:
 * unauthenticated -> 401; the stranger -> `miss`; the actor (who may use it) -> `ok`; with `lacking`, the actor
 * after losing that one thing -> its status.
 */
const app = buildApp(env);
const call = caller(app);

/** Routes with no user token on purpose, with the reason. */
const ALLOWLIST: Record<string, string> = {
  "POST /livekit/webhook": "called by LiveKit, authenticated by its signature over the raw body (webhook.test.ts)",
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Row = {
  route: string;
  ok: number;
  miss: number;
  url: (f: Fixture) => string;
  lacking?: { why: string; status: number; revoke: (f: Fixture) => Promise<unknown> };
};

const ROWS: Row[] = [
  {
    route: "POST /channels/:channelId/voice/token", ok: 200, miss: 404, url: (f) => `/channels/${f.voice.id}/voice/token`,
    lacking: { why: "CONNECT", status: 403, revoke: (f) => setEveryone(f.guild.id, DEFAULT_EVERYONE_PERMISSIONS & ~P.CONNECT) },
  },
  {
    route: "GET /channels/:channelId/voice", ok: 200, miss: 404, url: (f) => `/channels/${f.voice.id}/voice`,
    lacking: { why: "VIEW_CHANNEL", status: 404, revoke: (f) => setEveryone(f.guild.id, DEFAULT_EVERYONE_PERMISSIONS & ~P.VIEW_CHANNEL) },
  },
  {
    route: "POST /dms/:dmId/call", ok: 200, miss: 404, url: (f) => `/dms/${f.dm.id}/call`,
    lacking: { why: "friendship", status: 403, revoke: (f) => call("DELETE", `/friends/${f.friend.id}`, f.actor.token) },
  },
  { route: "POST /dms/:dmId/call/decline", ok: 204, miss: 404, url: (f) => `/dms/${f.dm.id}/call/decline` },
];

/**
 * `actor` owns a guild with a voice channel (plain `member` is in it) and is friends with `friend` (DM open);
 * `stranger` knows nothing.
 */
async function fixture() {
  const [actor, friend, stranger, member] = await Promise.all(["actor", "friend", "stranger", "member"].map((n) => signUp(app, n)));
  const { guild } = await guildWith(app, actor, member);
  const voice = await addVoiceChannel(app, actor, guild.id);
  await befriend(app, actor, friend);
  const dm = (await call("POST", "/dms", actor.token, { userId: friend.id })).json() as { id: string };
  return { actor, friend, stranger, member, guild, voice, dm };
}

const send = (row: Row, f: Fixture, token?: string) => call(row.route.split(" ")[0] as Method, row.url(f), token);

beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("voice route guard", () => {
  it.each(ROWS.map((row) => [row.route, row] as const))("%s", async (_, row) => {
    const f = await fixture();
    expect((await send(row, f)).statusCode, "unauthenticated").toBe(401);
    expect((await send(row, f, f.stranger.token)).statusCode, "stranger").toBe(row.miss);
    expect((await send(row, f, f.actor.token)).statusCode, "actor").toBe(row.ok);
  });

  it.each(ROWS.filter((r) => r.lacking).map((row) => [`${row.route} without ${row.lacking!.why}`, row] as const))("%s", async (_, row) => {
    const f = await fixture();
    // the owner passes every guild check, so the plain member is the one under test (DM routes: the actor)
    const who = row.route.includes("/dms/") ? f.actor : f.member;
    await row.lacking!.revoke(f);
    expect((await send(row, f, who.token)).statusCode).toBe(row.lacking!.status);
  });

  it("every voice route is in the table or the allowlist", async () => {
    const probe = buildApp(env);
    const registered: string[] = [];
    probe.addHook("onRoute", (r) => {
      for (const m of [r.method].flat()) if (m !== "HEAD") registered.push(`${m} ${r.url}`);
    });
    await probe.ready();
    await probe.close();
    const mine = registered.filter(isVoiceRoute);
    const decided = [...ROWS.map((r) => r.route), ...Object.keys(ALLOWLIST)];
    expect(mine.filter((r) => !decided.includes(r)), "voice routes without a decision").toEqual([]);
    expect(decided.filter((r) => !mine.includes(r)), "stale rows").toEqual([]);
  });

  it("the allowlisted webhook really is closed to unsigned callers", async () => {
    const res = await app.inject({ method: "POST", url: "/livekit/webhook", payload: "{}", headers: { "content-type": "application/webhook+json" } });
    expect(res.statusCode).toBe(401);
  });
});
