import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, resetDb, signUp as signUpUser } from "../../test/helpers.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
const request = (from: { token: string }, to: { name: string }) => call("POST", "/friends/requests", from.token, { username: to.name });
const lists = async (u: { token: string }) => (await call("GET", "/friends", u.token)).json();
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

beforeEach(resetDb);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("friend requests", () => {
  it("send, list on both sides, accept", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    const sent = await request(a, b);
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toEqual({ status: "PENDING", user: { id: b.id, username: "bob" } });
    expect(await lists(a)).toEqual({ friends: [], incoming: [], outgoing: [{ id: b.id, username: "bob" }] });
    expect(await lists(b)).toEqual({ friends: [], incoming: [{ id: a.id, username: "alice" }], outgoing: [] });

    expect((await call("POST", `/friends/requests/${a.id}/accept`, b.token)).statusCode).toBe(200);
    for (const [me, other] of [[a, b], [b, a]] as const) {
      expect(await lists(me)).toEqual({ friends: [{ id: other.id, username: other.name, online: false, status: "offline" }], incoming: [], outgoing: [] });
    }
  });

  it("a request in the opposite direction accepts the pending one (200)", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await request(a, b);
    const res = await request(b, a);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ACCEPTED" });
    expect(ids((await lists(a)).friends)).toEqual([b.id]);
  });

  it("simultaneous mutual requests end as exactly one ACCEPTED row, never a 500", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    for (let i = 0; i < 5; i++) {
      await prisma.friendship.deleteMany();
      const res = await Promise.all([request(a, b), request(b, a)]);
      expect(res.map((r) => r.statusCode).sort()).toEqual([200, 201]);
      const rows = await prisma.friendship.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("ACCEPTED");
    }
  });

  it("the same body for an unknown user and for a block in either direction", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    const unknown = await call("POST", "/friends/requests", a.token, { username: "nobody" });
    expect(unknown.statusCode).toBe(404);
    await call("PUT", `/blocks/${b.id}`, a.token); // alice blocked bob
    await call("PUT", `/blocks/${a.id}`, c.token); // carol blocked alice
    for (const res of [await request(a, b), await request(b, a), await request(a, c), await request(c, a)]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(unknown.body);
    }
  });

  it("400 for yourself and for a bad username; 409 for a duplicate or an existing friend", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    expect((await request(a, a)).statusCode).toBe(400);
    expect((await call("POST", "/friends/requests", a.token, { username: "Not Valid" })).statusCode).toBe(400);
    expect((await call("POST", "/friends/requests", a.token, {})).statusCode).toBe(400);
    await request(a, b);
    expect((await request(a, b)).statusCode).toBe(409);
    await call("POST", `/friends/requests/${a.id}/accept`, b.token);
    expect((await request(a, b)).statusCode).toBe(409);
    expect((await request(b, a)).statusCode).toBe(409);
  });

  it("only the addressee accepts; unknown, malformed and unrelated ids are 404", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await request(a, b);
    expect((await call("POST", `/friends/requests/${b.id}/accept`, a.token)).statusCode).toBe(404); // requester
    expect((await call("POST", `/friends/requests/${a.id}/accept`, c.token)).statusCode).toBe(404); // third party
    expect((await call("POST", `/friends/requests/${c.id}/accept`, b.token)).statusCode).toBe(404); // no request
    expect((await call("POST", "/friends/requests/nope/accept", b.token)).statusCode).toBe(404);
    expect((await call("POST", `/friends/requests/${a.id}/accept`, b.token)).statusCode).toBe(200);
    expect((await call("POST", `/friends/requests/${a.id}/accept`, b.token)).statusCode).toBe(404); // already accepted
  });

  it("decline as addressee, cancel as requester; a stranger and an accepted friendship are 404", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await request(a, b);
    expect((await call("DELETE", `/friends/requests/${a.id}`, c.token)).statusCode).toBe(404);
    expect((await call("DELETE", `/friends/requests/${a.id}`, b.token)).statusCode).toBe(204); // decline
    expect(await lists(a)).toMatchObject({ outgoing: [] });
    await request(a, b);
    expect((await call("DELETE", `/friends/requests/${b.id}`, a.token)).statusCode).toBe(204); // cancel
    expect(await prisma.friendship.count()).toBe(0);
    await befriend(app, a, b);
    expect((await call("DELETE", `/friends/requests/${b.id}`, a.token)).statusCode).toBe(404); // not pending
    expect(await prisma.friendship.count()).toBe(1);
  });

  it("unfriend removes it for both; 404 when not friends", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    expect((await call("DELETE", `/friends/${b.id}`, a.token)).statusCode).toBe(404);
    await befriend(app, a, b);
    expect((await call("DELETE", `/friends/${a.id}`, c.token)).statusCode).toBe(404);
    expect((await call("DELETE", `/friends/${b.id}`, a.token)).statusCode).toBe(204);
    expect((await lists(b)).friends).toEqual([]);
    expect((await call("DELETE", `/friends/${b.id}`, a.token)).statusCode).toBe(404);
    expect((await call("DELETE", "/friends/nope", a.token)).statusCode).toBe(404);
  });

  it("the lists never expose email or password hash", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    expect(Object.keys((await lists(a)).friends[0]).sort()).toEqual(["id", "online", "status", "username"]);
  });
});

describe("blocks", () => {
  it("removes the friendship and pending requests in both directions; idempotent; listed", async () => {
    const [a, b, c] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    await befriend(app, a, b);
    await request(c, a);
    expect((await call("PUT", `/blocks/${b.id}`, a.token)).statusCode).toBe(204);
    expect((await call("PUT", `/blocks/${b.id}`, a.token)).statusCode).toBe(204); // idempotent
    expect((await call("PUT", `/blocks/${c.id}`, a.token)).statusCode).toBe(204);
    expect(await prisma.friendship.count()).toBe(0);
    expect(await prisma.block.count()).toBe(2);
    expect((await call("GET", "/blocks", a.token)).json()).toEqual(
      expect.arrayContaining([{ id: b.id, username: "bob" }, { id: c.id, username: "carol" }]),
    );
    expect((await call("GET", "/blocks", b.token)).json()).toEqual([]); // the blocked user sees nothing
  });

  it("a pending request from the blocked side is removed too", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await request(a, b);
    await call("PUT", `/blocks/${a.id}`, b.token);
    expect(await prisma.friendship.count()).toBe(0);
  });

  it("unblock is idempotent and does NOT restore the friendship", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    await call("PUT", `/blocks/${b.id}`, a.token);
    expect((await call("DELETE", `/blocks/${b.id}`, a.token)).statusCode).toBe(204);
    expect((await call("DELETE", `/blocks/${b.id}`, a.token)).statusCode).toBe(204);
    expect(await prisma.block.count()).toBe(0);
    expect((await lists(a)).friends).toEqual([]);
    expect((await request(a, b)).statusCode).toBe(201); // can ask again after unblock
  });

  it("400 for yourself; 404 for an unknown or malformed id", async () => {
    const a = await signUp("alice");
    expect((await call("PUT", `/blocks/${a.id}`, a.token)).statusCode).toBe(400);
    expect((await call("PUT", "/blocks/00000000-0000-4000-8000-000000000000", a.token)).statusCode).toBe(404);
    expect((await call("PUT", "/blocks/nope", a.token)).statusCode).toBe(404);
    expect((await call("DELETE", "/blocks/nope", a.token)).statusCode).toBe(404);
  });

  it("the blocked user cannot tell: friend request and DM answer exactly like for an unknown user", async () => {
    const [a, b] = await Promise.all([signUp("alice"), signUp("bob")]);
    await befriend(app, a, b);
    await call("PUT", `/blocks/${a.id}`, b.token); // bob blocks alice
    const ghost = "00000000-0000-4000-8000-000000000000";
    const unknownReq = await call("POST", "/friends/requests", a.token, { username: "nobody" });
    const blockedReq = await request(a, b);
    expect([blockedReq.statusCode, blockedReq.body]).toEqual([unknownReq.statusCode, unknownReq.body]);
    const unknownDm = await call("POST", "/dms", a.token, { userId: ghost });
    const blockedDm = await call("POST", "/dms", a.token, { userId: b.id });
    expect([blockedDm.statusCode, blockedDm.body]).toEqual([unknownDm.statusCode, unknownDm.body]);
  });
});
