import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Permission as P } from "@loop/shared";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, guildWith, PNG, resetDb, signUp as signUpUser, sizeOf } from "../../test/helpers.js";
import { connect as connectTo, listen, settle, until } from "../../test/sockets.js";
import { thumbKey } from "./dto.js";
import type { Fetcher } from "./fetch.js";

/**
 * The pipeline with a fake fetcher (the network side, and its SSRF rules, are fetch.test.ts). `web` is the fake
 * internet: URL -> HTML (null = the fetch fails), image URL -> bytes (null = refused by the fetcher's checks).
 */
const web = { pages: new Map<string, string | null>(), images: new Map<string, Buffer | null>(), pageCalls: [] as string[], gate: Promise.resolve() };
const fetcher = {
  page: async (url: string) => {
    web.pageCalls.push(url);
    await web.gate;
    const html = web.pages.get(url);
    return html == null ? null : { url, html };
  },
  image: async (url: string) => {
    const bytes = web.images.get(url);
    return bytes ? { contentType: "image/png", bytes } : null;
  },
} as Fetcher;
// The in-process cache lives as long as the app, so every test uses its own hostnames.
const og = (title: string, image?: string) => `<meta property="og:title" content="${title}"><meta property="og:description" content="About ${title}">${image ? `<meta property="og:image" content="${image}">` : ""}`;
const hold = () => {
  let open!: () => void;
  web.gate = new Promise<void>((r) => (open = r));
  return () => {
    open();
    web.gate = Promise.resolve();
  };
};

const appEnv = { ...env, linkPreviews: true, embedOverrides: { fetcher } };
const app = buildApp(appEnv);
const call = caller(app);
const signUp = (name: string) => signUpUser(app, name);
type U = Awaited<ReturnType<typeof signUp>>;
let port: number;
const sockets: Socket[] = [];
const extraApps: ReturnType<typeof buildApp>[] = [];

beforeAll(async () => {
  port = await listen(app);
});
beforeEach(async () => {
  await resetDb();
  web.pages.clear();
  web.images.clear();
  web.pageCalls = [];
  web.gate = Promise.resolve();
});
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.disconnect());
  await Promise.all(extraApps.splice(0).map((a) => a.close()));
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const EVENTS = ["message:update", "dm:message:update"];
const connect = (u: U) => connectTo(port, u.token, EVENTS, sockets);
const subscribe = (s: Socket, channelId: string) => s.emitWithAck("channel:subscribe", { channelId });
const post = async (u: U, channelId: string, content: string, a = app) => (await caller(a)("POST", `/channels/${channelId}/messages`, u.token, { content })).json() as { id: string; embeds: unknown[] };
const embedsOf = async (u: U, channelId: string) => ((await call("GET", `/channels/${channelId}/messages`, u.token)).json().messages as { embeds: any[] }[]).at(-1)!.embeds;

async function room() {
  const [owner, member] = await Promise.all(["owner", "member"].map(signUp));
  const { guild, general } = await guildWith(app, owner, member);
  return { owner, member, guild, general };
}

describe("unfurling after a send", () => {
  it("never blocks the sender; the preview arrives later as message:update and is in history", async () => {
    const { owner, member, general } = await room();
    web.pages.set("https://news.example/a", og("Big news"));
    const s = await connect(member);
    await subscribe(s, general.id);
    const release = hold(); // the fetch hangs until released
    const res = await call("POST", `/channels/${general.id}/messages`, owner.token, { content: "look https://news.example/a" });
    expect(res.statusCode).toBe(201);
    expect(res.json().embeds).toEqual([]);
    await until(() => web.pageCalls.length === 1);
    release();
    await app.embeds.idle();
    await until(() => s.got["message:update"]!.length === 1);
    const update = s.got["message:update"]![0];
    expect(update.id).toBe(res.json().id);
    expect(update.editedAt).toBeNull(); // not an edit
    expect(update.embeds).toEqual([{ url: "https://news.example/a", siteName: "news.example", title: "Big news", description: "About Big news", thumbnail: null }]);
    expect(await embedsOf(owner, general.id)).toEqual(update.embeds);
  });

  it("up to three URLs in text order; failures are silent and leave no row", async () => {
    const { owner, general } = await room();
    for (const n of [1, 2, 4]) web.pages.set(`https://s${n}.example/`, og(`S${n}`));
    web.pages.set("https://s3.example/", null);
    await post(owner, general.id, "https://s1.example https://s2.example https://s3.example https://s4.example `https://code.example`");
    await app.embeds.idle();
    expect(web.pageCalls.sort()).toEqual(["https://s1.example/", "https://s2.example/", "https://s3.example/"]);
    expect((await embedsOf(owner, general.id)).map((e) => e.title)).toEqual(["S1", "S2"]);
  });

  it("a message without previewable URLs, or with LINK_PREVIEWS=off, fetches nothing", async () => {
    const { owner, general } = await room();
    await post(owner, general.id, "no links here <https://quiet.example>");
    const off = buildApp({ ...appEnv, linkPreviews: false });
    extraApps.push(off);
    web.pages.set("https://a.example/", og("A"));
    await post(owner, general.id, "https://a.example", off);
    await app.embeds.idle();
    await off.embeds.idle();
    expect(web.pageCalls).toEqual([]);
    expect(await prisma.messageEmbed.count()).toBe(0);
  });

  it("works for pair DMs, group DMs and threads", async () => {
    const [a, b, c] = await Promise.all(["ann", "bob", "cat"].map(signUp));
    await befriend(app, a, b);
    await befriend(app, a, c);
    web.pages.set("https://d.example/", og("D"));
    const sb = await connect(b);
    const sc = await connect(c);
    const dm = (await call("POST", "/dms", a.token, { userId: b.id })).json();
    await call("POST", `/dms/${dm.id}/messages`, a.token, { content: "https://d.example" });
    await app.embeds.idle();
    await until(() => sb.got["dm:message:update"]!.length === 1);
    expect(sb.got["dm:message:update"]![0].embeds[0].title).toBe("D");
    const group = (await call("POST", "/dms/group", a.token, { userIds: [b.id, c.id] })).json();
    await call("POST", `/dms/${group.id}/messages`, a.token, { content: "https://d.example" });
    await app.embeds.idle();
    await until(() => sc.got["dm:message:update"]!.length === 1);
    expect(sc.got["dm:message:update"]![0].dmChannelId).toBe(group.id);

    const { general } = await guildWith(app, a, b);
    const starter = await post(a, general.id, "topic");
    const thread = (await call("POST", `/channels/${general.id}/messages/${starter.id}/thread`, a.token, { name: "t" })).json();
    await subscribe(sb, thread.id);
    await post(a, thread.id, "https://d.example");
    await app.embeds.idle();
    await until(() => sb.got["message:update"]!.some((m) => m.channelId === thread.id && m.embeds.length === 1));
  });

  it("users who cannot see the channel never receive its previews", async () => {
    const { owner, member, guild, general } = await room();
    const secret = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "secret", type: "TEXT" })).json();
    await call("PUT", `/channels/${secret.id}/overwrites/${guild.id}`, owner.token, { allow: 0, deny: P.VIEW_CHANNEL });
    web.pages.set("https://s.example/", og("Secret"));
    const s = await connect(member);
    expect(await subscribe(s, secret.id)).toMatchObject({ ok: false });
    await subscribe(s, general.id);
    await post(owner, secret.id, "https://s.example");
    await app.embeds.idle();
    await settle();
    expect(s.got["message:update"]).toEqual([]);
  });
});

describe("thumbnails", () => {
  it("are stored under embeds/<random> and served through a public 302 by an unguessable id", async () => {
    const { owner, general } = await room();
    web.pages.set("https://pt6.example/", og("Pic", "/cover.png"));
    web.images.set("https://pt6.example/cover.png", PNG);
    await post(owner, general.id, "https://pt6.example");
    await app.embeds.idle();
    const [embed] = await embedsOf(owner, general.id);
    expect(embed.thumbnail).toMatch(/^\/embeds\/[0-9a-f-]{36}\/thumbnail$/);
    const row = await prisma.messageEmbed.findFirstOrThrow();
    expect(await sizeOf(thumbKey(row.thumbHash!))).toBe(PNG.length);
    const res = await app.inject({ method: "GET", url: embed.thumbnail }); // no token
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(thumbKey(row.thumbHash!));
    expect(await (await fetch(res.headers.location as string)).arrayBuffer().then((b) => Buffer.from(b))).toEqual(PNG);
  });

  it("an image the fetcher refused means no thumbnail; unknown, malformed and thumbnail-less ids are one 404", async () => {
    const { owner, general } = await room();
    web.pages.set("https://pt7.example/", og("Pic", "https://pt7.example/not-an-image"));
    web.images.set("https://pt7.example/not-an-image", null);
    await post(owner, general.id, "https://pt7.example");
    await app.embeds.idle();
    const row = await prisma.messageEmbed.findFirstOrThrow();
    expect(row.thumbHash).toBeNull();
    for (const id of [row.id, "00000000-0000-4000-8000-000000000000", "nope"]) {
      const res = await app.inject({ method: "GET", url: `/embeds/${id}/thumbnail` });
      expect([res.statusCode, res.json()]).toEqual([404, { error: "Not found" }]);
    }
  });

  it("deleting the message cascades the rows and removes the thumbnail object", async () => {
    const { owner, general } = await room();
    web.pages.set("https://pt8.example/", og("Pic", "https://pt8.example/i.png"));
    web.images.set("https://pt8.example/i.png", PNG);
    const m = await post(owner, general.id, "https://pt8.example");
    await app.embeds.idle();
    const { thumbHash } = await prisma.messageEmbed.findFirstOrThrow();
    expect((await call("DELETE", `/messages/${m.id}`, owner.token)).statusCode).toBe(204);
    expect(await prisma.messageEmbed.count()).toBe(0);
    expect(await sizeOf(thumbKey(thumbHash!))).toBeNull();
  });

  it("a message deleted while its preview is being fetched leaves neither row nor object", async () => {
    const { owner, general } = await room();
    web.pages.set("https://pt9.example/", og("Pic", "https://pt9.example/i.png"));
    web.images.set("https://pt9.example/i.png", PNG);
    const release = hold();
    const m = await post(owner, general.id, "https://pt9.example");
    await until(() => web.pageCalls.length === 1);
    await call("DELETE", `/messages/${m.id}`, owner.token);
    release();
    await app.embeds.idle();
    expect(await prisma.messageEmbed.count()).toBe(0);
  });
});

describe("edits", () => {
  it("keep rows of URLs still there, drop removed ones, unfurl only the new ones", async () => {
    const { owner, member, general } = await room();
    for (const n of ["a", "b", "c"]) web.pages.set(`https://${n}.example/`, og(n.toUpperCase(), `https://${n}.example/i.png`));
    for (const n of ["a", "b", "c"]) web.images.set(`https://${n}.example/i.png`, PNG);
    const m = await post(owner, general.id, "https://a.example https://b.example");
    await app.embeds.idle();
    const before = await prisma.messageEmbed.findMany({ orderBy: { position: "asc" } });
    const s = await connect(member);
    await subscribe(s, general.id);
    web.pageCalls = [];
    const res = await call("PATCH", `/messages/${m.id}`, owner.token, { content: "https://b.example then https://c.example" });
    expect(res.json().embeds.map((e: any) => e.title)).toEqual(["B"]); // kept at once, the new one follows
    await app.embeds.idle();
    expect(web.pageCalls).toEqual(["https://c.example/"]);
    const after = await prisma.messageEmbed.findMany({ orderBy: { position: "asc" } });
    expect(after.map((e) => [e.url, e.position])).toEqual([["https://b.example/", 0], ["https://c.example/", 1]]);
    expect(after[0]!.id).toBe(before[1]!.id); // the same row, not a re-fetch
    expect(await sizeOf(thumbKey(before[0]!.thumbHash!))).toBeNull(); // A's thumbnail went with its row
    await until(() => s.got["message:update"]!.some((u) => u.embeds.length === 2));
  });

  it("a URL edited out while it was being fetched gets no row; the one still there does", async () => {
    const { owner, general } = await room();
    web.pages.set("https://eo1.example/", og("Gone"));
    web.pages.set("https://eo2.example/", og("Kept"));
    const release = hold();
    const m = await post(owner, general.id, "https://eo1.example https://eo2.example");
    await until(() => web.pageCalls.length === 2);
    await call("PATCH", `/messages/${m.id}`, owner.token, { content: "only https://eo2.example" });
    release();
    await app.embeds.idle();
    expect((await prisma.messageEmbed.findMany()).map((e) => [e.url, e.position])).toEqual([["https://eo2.example/", 0]]);
  });
});

describe("cost controls", () => {
  it("cache: the same URL is fetched once (and once while in flight); each embed owns its thumbnail copy", async () => {
    const { owner, general } = await room();
    web.pages.set("https://cc.example/", og("C", "https://cc.example/i.png"));
    web.images.set("https://cc.example/i.png", PNG);
    const release = hold();
    const first = await post(owner, general.id, "https://cc.example");
    await post(owner, general.id, "again https://cc.example#frag-is-ignored");
    await until(() => web.pageCalls.length === 1);
    release();
    await app.embeds.idle();
    await post(owner, general.id, "and again https://cc.example");
    await app.embeds.idle();
    expect(web.pageCalls).toEqual(["https://cc.example/"]);
    const rows = await prisma.messageEmbed.findMany();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.thumbHash)).size).toBe(3);
    await call("DELETE", `/messages/${first.id}`, owner.token);
    for (const r of await prisma.messageEmbed.findMany()) expect(await sizeOf(thumbKey(r.thumbHash!))).toBe(PNG.length);
  });

  it("negative cache: a failed URL is not fetched again soon", async () => {
    const { owner, general } = await room();
    web.pages.set("https://down.example/", null);
    await post(owner, general.id, "https://down.example");
    await app.embeds.idle();
    await post(owner, general.id, "https://down.example");
    await app.embeds.idle();
    expect(web.pageCalls).toEqual(["https://down.example/"]);
  });

  it("concurrency cap and bounded queue: beyond them a fetch is dropped (and not remembered as a failure)", async () => {
    const small = buildApp({ ...appEnv, embedOverrides: { fetcher, concurrency: 1, queueMax: 1 } });
    extraApps.push(small);
    const { owner, general } = await room();
    for (const n of [1, 2, 3]) web.pages.set(`https://q${n}.example/`, og(`Q${n}`));
    const release = hold();
    for (const n of [1, 2, 3]) await post(owner, general.id, `https://q${n}.example`, small);
    await until(() => web.pageCalls.length === 1);
    await settle();
    expect(web.pageCalls).toHaveLength(1); // one running, one waiting, one dropped
    release();
    await small.embeds.idle();
    expect(web.pageCalls).toEqual(["https://q1.example/", "https://q2.example/"]);
    await post(owner, general.id, "https://q3.example again", small);
    await small.embeds.idle();
    expect(web.pageCalls).toContain("https://q3.example/");
  });

  it("per-user budget: over it the URL is just skipped, other users are unaffected", async () => {
    const tight = buildApp({ ...appEnv, rateLimitOverrides: { policies: { "link-preview": { max: 2, windowMs: 60_000 } } } });
    extraApps.push(tight);
    const { owner, member, general } = await room();
    for (const n of [1, 2, 3, 4]) web.pages.set(`https://b${n}.example/`, og(`B${n}`));
    const res = await caller(tight)("POST", `/channels/${general.id}/messages`, owner.token, { content: "https://b1.example https://b2.example https://b3.example" });
    expect(res.statusCode).toBe(201);
    await tight.embeds.idle();
    expect(web.pageCalls.sort()).toEqual(["https://b1.example/", "https://b2.example/"]);
    await post(member, general.id, "https://b4.example", tight);
    await tight.embeds.idle();
    expect(web.pageCalls).toContain("https://b4.example/");
  });
});
