import type { Socket } from "socket.io-client";
import { categoryDeletedEventSchema, layoutUpdatedEventSchema, Permission as P } from "@loop/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, guildWith, makeRole, resetDb, signUp } from "../../test/helpers.js";
import { connect, listen, settle, until } from "../../test/sockets.js";

const app = buildApp(env);
const call = caller(app);
const sockets: Socket[] = [];
let port: number;

beforeAll(async () => {
  port = await listen(app);
});
beforeEach(resetDb);
afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

type Cat = { id: string; name: string; position: number };
type Chan = { id: string; name: string; categoryId: string | null; position: number };

async function setup() {
  const [owner, member, outsider] = await Promise.all(["owner", "member", "outsider"].map((n) => signUp(app, n)));
  const { guild, general } = await guildWith(app, owner, member);
  const base = `/guilds/${guild.id}`;
  const view = async (token = owner.token) => (await call("GET", base, token)).json() as { channels: Chan[]; categories: Cat[] };
  const [text, voice] = (await view()).categories;
  const addChannel = async (name: string, categoryId?: string) =>
    (await call("POST", `${base}/channels`, owner.token, { name, type: "TEXT", categoryId })).json() as Chan;
  const layout = (token: string, body: object) => call("PUT", `${base}/layout`, token, body);
  return { owner, member, outsider, guild, general, base, view, text: text!, voice: voice!, addChannel, layout };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const placement = (f: Ctx, id: string, categoryId: string | null) => ({ id, categoryId });
const order = (channels: Chan[], categoryId: string | null) =>
  channels.filter((c) => c.categoryId === categoryId).sort((a, b) => a.position - b.position).map((c) => c.name);

describe("category CRUD", () => {
  it("creates last, trims, rejects duplicates and bad names; rename; 404s", async () => {
    const f = await setup();
    const res = await call("POST", `${f.base}/categories`, f.owner.token, { name: "  Games " });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Games", position: 2, guildId: f.guild.id });
    expect((await call("POST", `${f.base}/categories`, f.owner.token, { name: "Games" })).statusCode).toBe(409);
    expect((await call("POST", `${f.base}/categories`, f.owner.token, { name: "   " })).statusCode).toBe(400);
    expect((await call("POST", `${f.base}/categories`, f.member.token, { name: "x" })).statusCode).toBe(403);

    const id = res.json().id;
    const renamed = await call("PATCH", `${f.base}/categories/${id}`, f.owner.token, { name: "Music" });
    expect([renamed.statusCode, renamed.json().name]).toEqual([200, "Music"]);
    expect((await call("PATCH", `${f.base}/categories/${id}`, f.owner.token, { name: f.text.name })).statusCode).toBe(409);
    expect((await call("PATCH", `${f.base}/categories/${id}`, f.owner.token, {})).statusCode).toBe(400);
    expect((await call("PATCH", `${f.base}/categories/nope`, f.owner.token, { name: "a" })).statusCode).toBe(404);

    const other = await setup2(f);
    expect((await call("PATCH", `${f.base}/categories/${other.id}`, f.owner.token, { name: "a" })).statusCode, "foreign category").toBe(404);
    expect((await call("DELETE", `${f.base}/categories/${other.id}`, f.owner.token)).statusCode).toBe(404);
    expect((await call("DELETE", `${f.base}/categories/${id}`, f.owner.token)).statusCode).toBe(204);
    expect((await call("DELETE", `${f.base}/categories/${id}`, f.owner.token)).statusCode).toBe(404);
  });

  it("deleting a category keeps its channels, appended uncategorised in their old order", async () => {
    const f = await setup();
    await f.addChannel("u1");
    await f.addChannel("u2");
    await f.addChannel("a", f.text.id);
    await call("DELETE", `${f.base}/categories/${f.text.id}`, f.owner.token);
    const { channels, categories } = await f.view();
    expect(categories.map((c) => c.name)).toEqual([f.voice.name]);
    expect(order(channels, null)).toEqual(["u1", "u2", "general", "a"]);
    expect(channels.map((c) => c.position).sort()).toEqual([0, 1, 2, 3]);
  });
});

/** A category of an unrelated guild. */
const setup2 = async (f: Ctx) => {
  const g = (await call("POST", "/guilds", f.owner.token, { name: "Other" })).json();
  return g.categories[0] as Cat;
};

describe("POST /guilds/:id/channels with categoryId", () => {
  it("places the channel last in the category; an unknown or foreign category is 400", async () => {
    const f = await setup();
    const a = await f.addChannel("a", f.text.id);
    expect([a.categoryId, a.position]).toEqual([f.text.id, 1]);
    const v = await f.addChannel("v", f.voice.id);
    expect([v.categoryId, v.position]).toEqual([f.voice.id, 0]);
    const foreign = await setup2(f);
    for (const categoryId of [foreign.id, crypto.randomUUID()]) {
      expect((await call("POST", `${f.base}/channels`, f.owner.token, { name: "z", type: "TEXT", categoryId })).statusCode).toBe(400);
    }
  });
});

describe("PUT /guilds/:id/layout", () => {
  it("reorders categories and moves channels between categories and the uncategorised area, persisted", async () => {
    const f = await setup();
    const a = await f.addChannel("a", f.text.id);
    const loose = await f.addChannel("loose");
    const res = await f.layout(f.owner.token, {
      categories: [f.voice.id, f.text.id],
      channels: [
        placement(f, a.id, f.voice.id),
        placement(f, f.general.id, null),
        placement(f, loose.id, f.text.id),
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(layoutUpdatedEventSchema.safeParse(res.json()).success).toBe(true);
    const { channels, categories } = await f.view();
    expect(categories.map((c) => c.name)).toEqual([f.voice.name, f.text.name]);
    expect(order(channels, f.voice.id)).toEqual(["a"]);
    expect(order(channels, f.text.id)).toEqual(["loose"]);
    expect(order(channels, null)).toEqual(["general"]);
    // channel order inside one category follows list order
    await f.layout(f.owner.token, {
      categories: [f.voice.id, f.text.id],
      channels: [placement(f, loose.id, f.text.id), placement(f, a.id, f.text.id), placement(f, f.general.id, f.text.id)],
    });
    expect(order((await f.view()).channels, f.text.id)).toEqual(["loose", "a", "general"]);
  });

  it("rejects duplicates, foreign ids and missing categories (400), stale or incomplete lists (409)", async () => {
    const f = await setup();
    const a = await f.addChannel("a", f.text.id);
    const foreign = await setup2(f);
    const cats = [f.text.id, f.voice.id];
    const all = [f.general.id, a.id].map((id) => placement(f, id, f.text.id));
    const put = (body: object) => f.layout(f.owner.token, body).then((r) => r.statusCode);
    expect(await put({ categories: cats, channels: all })).toBe(200);
    expect(await put({ categories: [...cats, f.text.id], channels: all }), "duplicate category").toBe(400);
    expect(await put({ categories: cats, channels: [...all, all[0]] }), "duplicate channel").toBe(400);
    expect(await put({ categories: cats, channels: [placement(f, f.general.id, foreign.id), all[1]] }), "category not listed").toBe(400);
    expect(await put({ categories: [...cats, foreign.id], channels: all }), "foreign category").toBe(400);
    expect(await put({ categories: cats, channels: [...all, placement(f, (await foreignChannel(f)).id, null)] }), "foreign channel").toBe(400);
    expect(await put({ categories: cats, channels: [all[0]] }), "missing channel").toBe(409);
    expect(await put({ categories: [f.text.id], channels: all }), "missing category").toBe(409);
    expect(await put({ categories: cats, channels: [...all, placement(f, crypto.randomUUID(), null)] }), "id that no longer exists").toBe(409);
    expect(await put({ categories: "x" })).toBe(400);
    expect((await f.layout(f.member.token, { categories: cats, channels: all })).statusCode, "no MANAGE_CHANNELS").toBe(403);
    expect((await f.layout(f.outsider.token, { categories: cats, channels: all })).statusCode).toBe(404);
  });

  it("a stale list after a concurrent create is 409 and changes nothing", async () => {
    const f = await setup();
    const before = await f.view();
    const body = { categories: [f.voice.id, f.text.id], channels: [placement(f, f.general.id, null)] };
    await f.addChannel("new"); // created between the client's read and write
    expect((await f.layout(f.owner.token, body)).statusCode).toBe(409);
    expect((await f.view()).categories).toEqual(before.categories);
  });

  describe("a caller who cannot see some channels", () => {
    async function withSecret() {
      const f = await setup();
      await makeRole(f.guild.id, 1, P.MANAGE_CHANNELS, [f.member.id]);
      const secret = await f.addChannel("secret", f.text.id);
      const a = await f.addChannel("a", f.text.id);
      await prisma.channelOverwrite.create({ data: { guildId: f.guild.id, channelId: secret.id, roleId: f.guild.id, allow: 0, deny: P.VIEW_CHANNEL } });
      return { ...f, secret, a };
    }

    it("lists only the visible channels; hidden ones keep their category and sit after the visible ones", async () => {
      const f = await withSecret();
      expect((await f.view(f.member.token)).channels.map((c) => c.name)).not.toContain("secret");
      const cats = [f.text.id, f.voice.id];
      const res = await f.layout(f.member.token, {
        categories: cats,
        channels: [placement(f, f.a.id, f.text.id), placement(f, f.general.id, f.text.id)],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().channels.map((c: { id: string }) => c.id), "response omits the hidden channel").toEqual([f.a.id, f.general.id]);
      const text = (await f.view()).channels.filter((c) => c.categoryId === f.text.id);
      expect(order(text, f.text.id)).toEqual(["a", "general", "secret"]);
      expect(text.map((c) => c.position).sort()).toEqual([0, 1, 2]);
      // moving every visible channel out leaves the hidden one in its category
      await f.layout(f.member.token, { categories: cats, channels: [placement(f, f.a.id, f.voice.id), placement(f, f.general.id, f.voice.id)] });
      const { channels } = await f.view();
      expect(channels.find((c) => c.name === "secret")).toMatchObject({ categoryId: f.text.id, position: 0 });
      expect(order(channels, f.voice.id)).toEqual(["a", "general"]);
    });

    it("naming the hidden channel is 400; omitting a visible one is 409", async () => {
      const f = await withSecret();
      const cats = [f.text.id, f.voice.id];
      const visible = [f.a.id, f.general.id].map((id) => placement(f, id, f.text.id));
      expect((await f.layout(f.member.token, { categories: cats, channels: [...visible, placement(f, f.secret.id, null)] })).statusCode).toBe(400);
      expect((await f.layout(f.member.token, { categories: cats, channels: [visible[0]] })).statusCode).toBe(409);
      // the owner sees everything and must list everything
      expect((await f.layout(f.owner.token, { categories: cats, channels: visible })).statusCode).toBe(409);
    });
  });
});

const foreignChannel = async (f: Ctx) => {
  const g = (await call("POST", "/guilds", f.owner.token, { name: "Other2" })).json();
  return g.channels[0] as Chan;
};

describe("realtime", () => {
  const EVENTS = ["channel:created", "category:created", "category:updated", "category:deleted", "layout:updated"];

  it("members get every event with the documented payload; a non-member gets none", async () => {
    const f = await setup();
    const member = await connect(port, f.member.token, EVENTS, sockets);
    const outsider = await connect(port, f.outsider.token, EVENTS, sockets);
    const created = (await call("POST", `${f.base}/categories`, f.owner.token, { name: "New" })).json();
    await until(() => member.got["category:created"]!.length);
    expect(member.got["category:created"]![0]).toMatchObject({ id: created.id, name: "New", guildId: f.guild.id });

    await call("PATCH", `${f.base}/categories/${created.id}`, f.owner.token, { name: "Newer" });
    await until(() => member.got["category:updated"]!.length);
    expect(member.got["category:updated"]![0].name).toBe("Newer");

    const ch = await f.addChannel("c", created.id);
    await until(() => member.got["channel:created"]!.length);
    expect(member.got["channel:created"]![0]).toMatchObject({ id: ch.id, categoryId: created.id, position: 0 });

    const cats = [created.id, f.text.id, f.voice.id];
    await f.layout(f.owner.token, { categories: cats, channels: [placement(f, ch.id, null), placement(f, f.general.id, f.text.id)] });
    await until(() => member.got["layout:updated"]!.length);
    const layout = member.got["layout:updated"]![0];
    expect(layoutUpdatedEventSchema.safeParse(layout).success).toBe(true);
    expect(layout.categories.map((c: { id: string }) => c.id)).toEqual(cats);
    expect(layout.channels).toContainEqual({ id: ch.id, categoryId: null, position: 0 });

    await call("DELETE", `${f.base}/categories/${f.text.id}`, f.owner.token);
    await until(() => member.got["category:deleted"]!.length);
    const deleted = member.got["category:deleted"]![0];
    expect(categoryDeletedEventSchema.safeParse(deleted).success).toBe(true);
    expect(deleted).toEqual({ guildId: f.guild.id, categoryId: f.text.id, channels: [{ id: f.general.id, categoryId: null, position: 1 }] });

    await settle();
    for (const e of EVENTS) expect(outsider.got[e], e).toEqual([]);
  });

  it("hidden channels never appear in layout:updated or category:deleted of a member who cannot view them", async () => {
    const f = await setup();
    const secret = await f.addChannel("secret", f.text.id);
    await prisma.channelOverwrite.create({ data: { guildId: f.guild.id, channelId: secret.id, roleId: f.guild.id, allow: 0, deny: P.VIEW_CHANNEL } });
    const member = await connect(port, f.member.token, EVENTS, sockets);
    const owner = await connect(port, f.owner.token, EVENTS, sockets);
    await f.layout(f.owner.token, {
      categories: [f.voice.id, f.text.id],
      channels: [secret.id, f.general.id].map((id) => placement(f, id, f.text.id)),
    });
    await until(() => member.got["layout:updated"]!.length && owner.got["layout:updated"]!.length);
    const ids = (c: Socket & { got: Record<string, any[]> }) => c.got["layout:updated"]![0].channels.map((x: { id: string }) => x.id);
    expect(ids(member)).toEqual([f.general.id]);
    expect(ids(owner).sort()).toEqual([f.general.id, secret.id].sort());

    await call("DELETE", `${f.base}/categories/${f.text.id}`, f.owner.token);
    await until(() => member.got["category:deleted"]!.length && owner.got["category:deleted"]!.length);
    expect(member.got["category:deleted"]![0].channels.map((c: { id: string }) => c.id)).toEqual([f.general.id]);
    expect(owner.got["category:deleted"]![0].channels).toHaveLength(2);
  });
});
