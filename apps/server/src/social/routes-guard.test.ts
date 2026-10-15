import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, isSocialRoute, type Method, resetDb, signUp } from "../../test/helpers.js";

/**
 * Every friends / blocks / DM route and what it does to someone with no relation to the target. A social
 * route missing from ROWS fails the guard below, so a new route cannot ship without this decision.
 * Each row: unauthenticated -> 401; `miss` (run as a stranger, optionally with another url/body) -> its status;
 * `own` instead of `miss` says why the route has no target to be unrelated to; the related caller gets `ok`.
 */
const app = buildApp(env);
const call = caller(app);

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Row = {
  route: string;
  ok: number;
  url: (f: Fixture) => string;
  body?: (f: Fixture) => object;
  miss?: { status: number; url?: (f: Fixture) => string; body?: (f: Fixture) => object };
  own?: string;
};

const ROWS: Row[] = [
  { route: "GET /friends", ok: 200, url: () => "/friends", own: "lists only the caller's own friends and requests" },
  { route: "POST /friends/requests", ok: 201, url: () => "/friends/requests", body: (f) => ({ username: f.fresh.name }), miss: { status: 404, body: () => ({ username: "ghost" }) } },
  { route: "POST /friends/requests/:userId/accept", ok: 200, url: (f) => `/friends/requests/${f.requester.id}/accept`, miss: { status: 404 } },
  { route: "DELETE /friends/requests/:userId", ok: 204, url: (f) => `/friends/requests/${f.requester.id}`, miss: { status: 404 } },
  { route: "DELETE /friends/:userId", ok: 204, url: (f) => `/friends/${f.friend.id}`, miss: { status: 404 } },
  { route: "GET /blocks", ok: 200, url: () => "/blocks", own: "lists only the caller's own blocks" },
  { route: "PUT /blocks/:userId", ok: 204, url: (f) => `/blocks/${f.fresh.id}`, miss: { status: 404, url: () => "/blocks/nope" } },
  { route: "DELETE /blocks/:userId", ok: 204, url: (f) => `/blocks/${f.fresh.id}`, miss: { status: 404, url: () => "/blocks/nope" } },
  { route: "POST /dms", ok: 201, url: () => "/dms", body: (f) => ({ userId: f.friend2.id }), miss: { status: 404, body: (f) => ({ userId: f.friend.id }) } },
  { route: "GET /dms", ok: 200, url: () => "/dms", own: "lists only the caller's own DM channels" },
  { route: "POST /dms/:dmId/messages", ok: 201, url: (f) => `/dms/${f.dm.id}/messages`, body: () => ({ content: "hi" }), miss: { status: 404 } },
  { route: "GET /dms/:dmId/messages", ok: 200, url: (f) => `/dms/${f.dm.id}/messages`, miss: { status: 404 } },
  { route: "GET /me/status", ok: 200, url: () => "/me/status", own: "the caller's own status preference" },
  { route: "PUT /me/status", ok: 200, url: () => "/me/status", body: () => ({ status: "dnd" }), own: "sets the caller's own status preference" },
];

/** actor is friends with `friend` (DM open) and `friend2`, has a request from `requester`; `fresh` and `stranger` are unrelated. */
async function fixture() {
  const [actor, friend, friend2, requester, fresh, stranger] = await Promise.all(
    ["actor", "friend", "friend2", "requester", "fresh", "stranger"].map((n) => signUp(app, n)),
  );
  await befriend(app, actor, friend);
  await befriend(app, actor, friend2);
  await call("POST", "/friends/requests", requester.token, { username: "actor" });
  const dm = (await call("POST", "/dms", actor.token, { userId: friend.id })).json() as { id: string };
  return { actor, friend, friend2, requester, fresh, stranger, dm };
}

const send = (row: Row, f: Fixture, token?: string, over?: Row["miss"]) =>
  call(row.route.split(" ")[0] as Method, (over?.url ?? row.url)(f), token, (over?.body ?? row.body)?.(f));

beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("social route guard", () => {
  it.each(ROWS.map((row) => [row.route, row] as const))("%s", async (_, row) => {
    const f = await fixture();
    expect((await send(row, f)).statusCode, "unauthenticated").toBe(401);
    if (row.miss) expect((await send(row, f, f.stranger.token, row.miss)).statusCode, "stranger / unknown target").toBe(row.miss.status);
    else expect(row.own, "a row without `miss` must say why").toBeTruthy();
    expect((await send(row, f, f.actor.token)).statusCode, "related caller").toBe(row.ok);
  });

  it("every social route is in the table", async () => {
    const probe = buildApp(env);
    const registered: string[] = [];
    probe.addHook("onRoute", (r) => {
      for (const m of [r.method].flat()) if (m !== "HEAD") registered.push(`${m} ${r.url}`);
    });
    await probe.ready();
    await probe.close();
    const social = registered.filter(isSocialRoute);
    const decided = ROWS.map((r) => r.route);
    expect(social.filter((r) => !decided.includes(r)), "social routes without a decision").toEqual([]);
    expect(decided.filter((r) => !social.includes(r)), "stale rows").toEqual([]);
  });
});
