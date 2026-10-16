import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, resetDb, signUp } from "../../test/helpers.js";

/** The provider is a fake: no internet in tests. `calls` are the exact URLs the server asked GIPHY for. */
const KEY = "test-giphy-key-0123456789";
const calls: string[] = [];
let answer: () => unknown = () => ({ data: [], pagination: { total_count: 0 } });
const fetchJson = async (url: string) => {
  calls.push(url);
  return answer();
};
const rendition = (url: string, w = 200, h = 150, size: string | number = "12345") => ({ url, width: String(w), height: String(h), size: String(size) });
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `title ${id}`,
  images: {
    fixed_height: rendition(`https://media2.giphy.com/media/${id}/200.gif?cid=abc&rid=200.gif`),
    fixed_width_small: rendition(`https://media2.giphy.com/media/${id}/100w.gif`, 100, 75),
  },
  ...over,
});

const on = buildApp({ ...env, giphyApiKey: KEY, gifOverrides: { fetchJson } });
const off = buildApp(env);
const call = caller(on);
let token: string;

beforeAll(async () => {
  await resetDb();
  token = (await signUp(on, "gifuser")).token;
});
beforeEach(() => {
  calls.length = 0;
  answer = () => ({ data: [], pagination: { total_count: 0 } });
});
afterAll(async () => {
  await Promise.all([on.close(), off.close()]);
  await prisma.$disconnect();
});

describe("without GIPHY_API_KEY", () => {
  it("reports off, answers 404 and never calls out", async () => {
    const t = (await signUp(off, "gifoff")).token;
    const c = caller(off);
    expect((await c("GET", "/gifs/config", t)).json()).toEqual({ enabled: false });
    for (const url of ["/gifs/search?q=cat", "/gifs/trending"]) {
      const res = await c("GET", url, t);
      expect([res.statusCode, res.json()]).toEqual([404, { error: "Not found" }]);
    }
  });
});

describe("with a key", () => {
  it("needs a login, and config says enabled without leaking the key", async () => {
    for (const url of ["/gifs/config", "/gifs/search?q=a", "/gifs/trending"]) expect((await call("GET", url)).statusCode).toBe(401);
    const res = await call("GET", "/gifs/config", token);
    expect(res.json()).toEqual({ enabled: true });
  });

  it("maps a search: fixed provider URL and params, our shape, size hint in the fragment, no key in the answer", async () => {
    answer = () => ({ data: [item("abc123"), item("def456")], pagination: { total_count: 50, count: 2, offset: 0 } });
    const res = await call("GET", "/gifs/search?q=%20cat%20%26%20dog%20&limit=2&offset=4", token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { id: "abc123", title: "title abc123", previewUrl: "https://media2.giphy.com/media/abc123/100w.gif", url: "https://media2.giphy.com/media/abc123/200.gif?cid=abc&rid=200.gif#w=200&h=150", width: 200, height: 150 },
        expect.objectContaining({ id: "def456" }),
      ],
      nextOffset: 6,
    });
    expect(res.body).not.toContain(KEY);
    const url = new URL(calls[0]!);
    expect([url.origin, url.pathname]).toEqual(["https://api.giphy.com", "/v1/gifs/search"]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "cat & dog", offset: "4", limit: "2", rating: "pg-13", lang: "vi", bundle: "messaging_non_clips", api_key: KEY });
  });

  it("trending has no q and ends the paging at the last page", async () => {
    answer = () => ({ data: [item("x1")], pagination: { total_count: 1 } });
    const res = await call("GET", "/gifs/trending", token);
    expect(res.json().nextOffset).toBeNull();
    const url = new URL(calls[0]!);
    expect([url.pathname, url.searchParams.has("q"), url.searchParams.get("limit")]).toEqual(["/v1/gifs/trending", false, "24"]);
  });

  it("drops everything outside the allowlist, cleans titles, and survives garbage", async () => {
    const bad = (url: unknown, over: Record<string, unknown> = {}) => item("bad1", { images: { fixed_height: { ...rendition("x"), url, ...over } } });
    answer = () => ({
      data: [
        bad("https://evil.com/a.gif"),
        bad("http://media0.giphy.com/a.gif"),
        bad("javascript:alert(1)"),
        bad("https://media0.giphy.com.evil.com/a.gif"),
        bad("https://media0.giphy.com@evil.com/a.gif"),
        bad("https://media0.giphy.com:8443/a.gif"),
        bad("https://media0.giphy.com/a.gif", { size: String(9 * 1024 * 1024) }), // too big, and no original to fall back to
        bad("https://media0.giphy.com/a.gif", { width: "99999" }),
        bad(42),
        item("../etc", {}),
        { id: "nopics", images: null },
        null,
        "str",
        item("good1", { title: "  hi\u0000\u001b[31m there\n" + "x".repeat(200) }),
        // the sendable rendition is bad but the original is fine: the original is used
        { id: "orig1", title: "o", images: { fixed_height: rendition("https://evil.com/a.gif"), original: rendition("https://i.giphy.com/orig1.gif", 480, 270) } },
      ],
      pagination: { total_count: 500 },
    });
    const res = await call("GET", "/gifs/search?q=x", token);
    const results = res.json().results;
    expect(results.map((r: { id: string }) => r.id)).toEqual(["good1", "orig1"]);
    expect(results[0].title).toHaveLength(100);
    expect(results[0].title).not.toMatch(/[\u0000-\u001f]/);
    expect(results[1]).toMatchObject({ url: "https://i.giphy.com/orig1.gif#w=480&h=270", previewUrl: "https://i.giphy.com/orig1.gif", width: 480, height: 270 });
  });

  it("validates the query (nothing reaches the provider)", async () => {
    for (const url of ["/gifs/search", "/gifs/search?q=", "/gifs/search?q=" + "x".repeat(101), "/gifs/search?q=a&limit=31", "/gifs/search?q=a&limit=0", "/gifs/search?q=a&offset=-1", "/gifs/search?q=a&offset=9999", "/gifs/search?q=a&x=1", "/gifs/trending?limit=31", "/gifs/trending?q=a"]) {
      expect((await call("GET", url, token)).statusCode, url).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("serves a repeat from the 5 minute cache (one provider call), per distinct query", async () => {
    answer = () => ({ data: [item("c1")], pagination: { total_count: 1 } });
    for (let i = 0; i < 3; i++) expect((await call("GET", "/gifs/search?q=cache-me", token)).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    await call("GET", "/gifs/search?q=cache-me-not", token);
    await call("GET", "/gifs/search?q=cache-me&offset=24", token);
    expect(calls).toHaveLength(3);
  });

  it("expires the cache", async () => {
    const short = buildApp({ ...env, giphyApiKey: KEY, gifOverrides: { fetchJson, ttlMs: 1 } });
    try {
      const t = (await signUp(short, "gifshort")).token;
      await caller(short)("GET", "/gifs/trending?limit=3", t);
      await new Promise((r) => setTimeout(r, 10));
      await caller(short)("GET", "/gifs/trending?limit=3", t);
      expect(calls).toHaveLength(2);
    } finally {
      await short.close();
    }
  });

  it("answers a generic 502 when the provider fails (429, 500, timeout, junk), never its text or the key, and does not cache the failure", async () => {
    for (const fail of [new Error(`status 429 ${KEY}`), new Error("status 500"), new DOMException("The operation was aborted due to timeout", "TimeoutError"), null]) {
      answer = () => {
        if (fail) throw fail;
        return { oops: true };
      };
      const res = await call("GET", "/gifs/search?q=failing", token);
      expect([res.statusCode, res.json()]).toEqual([502, { error: "GIF service unavailable" }]);
      expect(res.body).not.toContain(KEY);
    }
    answer = () => ({ data: [item("ok1")], pagination: { total_count: 1 } });
    expect((await call("GET", "/gifs/search?q=failing", token)).json().results).toHaveLength(1);
  });

  it("rate limits search and trending together per user (gif-search)", async () => {
    const limited = buildApp({ ...env, rateLimit: true, giphyApiKey: KEY, gifOverrides: { fetchJson }, rateLimitOverrides: { policies: { "gif-search": { max: 2, windowMs: 60_000 } }, namespace: `${randomUUID()}:` } });
    try {
      const t = (await signUp(limited, "giflimit")).token;
      const c = caller(limited);
      const codes = [];
      for (const url of ["/gifs/search?q=a", "/gifs/trending", "/gifs/search?q=b", "/gifs/config"]) codes.push((await c("GET", url, t)).statusCode);
      expect(codes).toEqual([200, 200, 429, 200]);
    } finally {
      await limited.close();
    }
  });
});
