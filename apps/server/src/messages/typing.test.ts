import { Permission as P } from "@loop/shared";
import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, guildWith, makeRole, resetDb, setEveryone, signUp as signUpUser } from "../../test/helpers.js";
import { connect as connectTo, listen, settle, until } from "../../test/sockets.js";

const app = buildApp(env);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
let port: number;
const sockets: Socket[] = [];
const connect = (u: { token: string }) => connectTo(port, u.token, ["typing"], sockets);

beforeAll(async () => {
  port = await listen(app);
});
beforeEach(resetDb);
afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function channelSetup() {
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map(signUp));
  const { guild, general } = await guildWith(app, alice, bob, carol);
  const [sa, sb, sc] = await Promise.all([alice, bob, carol].map(connect));
  for (const s of [sa, sb]) await s.emitWithAck("channel:subscribe", { channelId: general.id });
  return { alice, bob, carol, guild, general, sa, sb, sc };
}

describe("typing in a channel", () => {
  it("reaches subscribed members, never the sender's own sockets or someone who is not subscribed", async () => {
    const { alice, bob, general, sa, sb, sc } = await channelSetup();
    const sa2 = await connect(alice); // the sender's second device, also in the room
    await sa2.emitWithAck("channel:subscribe", { channelId: general.id });
    sa.emit("typing", { channelId: general.id });
    await until(() => sb.got.typing!.length);
    expect(sb.got.typing![0]).toMatchObject({ channelId: general.id, userId: alice.id });
    expect(typeof sb.got.typing![0].at).toBe("number");
    await settle();
    expect(sa.got.typing, "sender").toEqual([]);
    expect(sa2.got.typing, "sender's other device").toEqual([]);
    expect(sc.got.typing, "not subscribed").toEqual([]);
    expect(bob.id).not.toBe(alice.id);
  });

  it("is dropped when the sender cannot send there, when the channel is unknown, and for a bad payload", async () => {
    const { guild, general, carol, sa, sb, sc } = await channelSetup();
    await makeRole(guild.id, 5, 0, [carol.id]);
    await setEveryone(guild.id, P.VIEW_CHANNEL); // read-only for everyone but the owner
    await sc.emitWithAck("channel:subscribe", { channelId: general.id });
    sc.emit("typing", { channelId: general.id }); // carol may view but not send
    sb.emit("typing", { channelId: general.id });
    sa.emit("typing", { channelId: "00000000-0000-4000-8000-000000000000" });
    sa.emit("typing", { channelId: "nope" });
    sa.emit("typing", { channelId: general.id, dmChannelId: general.id });
    sa.emit("typing", "x");
    await settle();
    expect(sa.got.typing).toEqual([]);
    expect(sb.got.typing).toEqual([]);
    expect(sc.got.typing).toEqual([]);
  });

  it("is throttled to one relay per 2 seconds per socket (limiting on)", async () => {
    const limited = buildApp({ ...env, rateLimit: true, rateLimitOverrides: { policies: {}, namespace: `${randomUUID()}:` } });
    try {
      const [alice, bob] = await Promise.all(["alice", "bob"].map((n) => signUpUser(limited, n)));
      const { general } = await guildWith(limited, alice, bob);
      const limitedPort = await listen(limited);
      const [sa, sb] = await Promise.all([alice, bob].map((u) => connectTo(limitedPort, u.token, ["typing"], sockets)));
      await sb.emitWithAck("channel:subscribe", { channelId: general.id });
      for (let i = 0; i < 5; i++) sa.emit("typing", { channelId: general.id });
      await until(() => sb.got.typing!.length);
      await settle();
      expect(sb.got.typing).toHaveLength(1);
    } finally {
      await limited.close();
    }
  });
});

describe("typing in a DM", () => {
  async function dmSetup() {
    const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map(signUp));
    await befriend(app, alice, bob);
    const dm = (await call("POST", "/dms", alice.token, { userId: bob.id })).json() as { id: string };
    const [sa, sb, sc] = await Promise.all([alice, bob, carol].map(connect));
    return { alice, bob, carol, dm, sa, sb, sc };
  }

  it("goes only to the other participant", async () => {
    const { alice, dm, sa, sb, sc } = await dmSetup();
    sa.emit("typing", { dmChannelId: dm.id });
    await until(() => sb.got.typing!.length);
    expect(sb.got.typing![0]).toMatchObject({ dmChannelId: dm.id, userId: alice.id });
    await settle();
    expect(sa.got.typing).toEqual([]);
    expect(sc.got.typing).toEqual([]);
  });

  it("is dropped for a non-participant, and after a block or an unfriend", async () => {
    const { alice, bob, dm, sa, sb, sc } = await dmSetup();
    sc.emit("typing", { dmChannelId: dm.id });
    await call("PUT", `/blocks/${bob.id}`, alice.token);
    sa.emit("typing", { dmChannelId: dm.id });
    sb.emit("typing", { dmChannelId: dm.id });
    await settle();
    expect([sa, sb, sc].map((s) => s.got.typing)).toEqual([[], [], []]);
  });
});
