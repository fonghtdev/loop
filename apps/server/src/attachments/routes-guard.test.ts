import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, isAttachmentRoute, type Method, PNG, resetDb, signUp } from "../../test/helpers.js";

/**
 * Every attachments route and what it does to someone with no relation to the target. A route missing from
 * ROWS fails the guard below, so a new route cannot ship without this decision. Each row: unauthenticated ->
 * 401; the stranger -> `miss`; the uploader (who can send in the channel) -> `ok`.
 */
const app = buildApp(env);
const call = caller(app);

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Row = { route: string; ok: number; miss: number; url: (f: Fixture) => string; body?: (f: Fixture) => object };

const ROWS: Row[] = [
  { route: "POST /attachments", ok: 201, miss: 404, url: () => "/attachments", body: (f) => ({ filename: "a.png", contentType: "image/png", size: 10, channelId: f.general.id }) },
  { route: "POST /attachments/:id/complete", ok: 200, miss: 404, url: (f) => `/attachments/${f.pendingId}/complete` },
  { route: "GET /attachments/:id", ok: 200, miss: 404, url: (f) => `/attachments/${f.pendingId}` },
];

/** `actor` owns a guild and has a pending upload there (bytes already stored); `stranger` knows nothing. */
async function fixture() {
  const [actor, stranger] = await Promise.all(["actor", "stranger"].map((n) => signUp(app, n)));
  const { general } = await guildWith(app, actor);
  const created = (await call("POST", "/attachments", actor.token, { filename: "a.png", contentType: "image/png", size: PNG.length, channelId: general.id })).json();
  await fetch(created.uploadUrl, { method: "PUT", headers: created.headers, body: PNG });
  return { actor, stranger, general, pendingId: created.id as string };
}

const send = (row: Row, f: Fixture, token?: string) => call(row.route.split(" ")[0] as Method, row.url(f), token, row.body?.(f));

beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("attachments route guard", () => {
  it.each(ROWS.map((row) => [row.route, row] as const))("%s", async (_, row) => {
    const f = await fixture();
    expect((await send(row, f)).statusCode, "unauthenticated").toBe(401);
    expect((await send(row, f, f.stranger.token)).statusCode, "stranger").toBe(row.miss);
    expect((await send(row, f, f.actor.token)).statusCode, "uploader").toBe(row.ok);
  });

  it("every attachments route is in the table", async () => {
    const probe = buildApp(env);
    const registered: string[] = [];
    probe.addHook("onRoute", (r) => {
      for (const m of [r.method].flat()) if (m !== "HEAD") registered.push(`${m} ${r.url}`);
    });
    await probe.ready();
    await probe.close();
    const mine = registered.filter(isAttachmentRoute);
    const decided = ROWS.map((r) => r.route);
    expect(mine.filter((r) => !decided.includes(r)), "attachments routes without a decision").toEqual([]);
    expect(decided.filter((r) => !mine.includes(r)), "stale rows").toEqual([]);
  });
});
