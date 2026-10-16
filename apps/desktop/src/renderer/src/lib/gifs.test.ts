import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GifPage, GifResult } from "@loop/shared";
import { createFlagPref } from "./embeds";
import { createGifPicker, DEBOUNCE_MS, gifBox, type GifApi } from "./gifs";

const gif = (id: string): GifResult => ({ id, title: id, previewUrl: `https://i.giphy.com/${id}.gif`, url: `https://i.giphy.com/${id}.gif`, width: 100, height: 100 });
const page = (ids: string[], nextOffset: number | null = null): GifPage => ({ results: ids.map(gif), nextOffset });

/** Each call returns a promise the test settles by hand, so answers can arrive out of order. */
function fakeApi() {
  const calls: { kind: string; q?: string; offset: number; resolve: (p: GifPage) => void; reject: () => void }[] = [];
  const ask = (kind: string, q: string | undefined, offset: number) =>
    new Promise<GifPage>((resolve, reject) => calls.push({ kind, q, offset, resolve, reject: () => reject(new Error("x")) }));
  const api: GifApi = { search: (q, offset) => ask("search", q, offset), trending: (offset) => ask("trending", undefined, offset) };
  return { api, calls };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("gif picker", () => {
  it("starts with trending and pages with nextOffset, without repeats", async () => {
    const { api, calls } = fakeApi();
    const p = createGifPicker(api);
    p.start();
    expect(p.get().phase).toBe("loading");
    calls[0]!.resolve(page(["a", "b"], 2));
    await flush();
    expect(p.get()).toMatchObject({ phase: "ready", nextOffset: 2, results: [gif("a"), gif("b")] });
    p.more();
    p.more(); // already loading more: ignored
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ kind: "trending", offset: 2 });
    calls[1]!.resolve(page(["b", "c"]));
    await flush();
    expect(p.get().results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    p.more(); // no next page
    expect(calls).toHaveLength(2);
  });

  it("debounces typing: one search 300 ms after the last key, trimmed", async () => {
    const { api, calls } = fakeApi();
    const p = createGifPicker(api);
    p.setQuery("c");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    p.setQuery(" ca ");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((c) => [c.kind, c.q, c.offset])).toEqual([["search", "ca", 0]]);
  });

  it("an empty box goes back to trending at once", async () => {
    const { api, calls } = fakeApi();
    const p = createGifPicker(api);
    p.setQuery("cat");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    p.setQuery("  ");
    expect(calls.map((c) => c.kind)).toEqual(["search", "trending"]);
  });

  it("drops the answer of a superseded query, even when it arrives last", async () => {
    const { api, calls } = fakeApi();
    const p = createGifPicker(api);
    p.setQuery("cat");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    p.setQuery("dog"); // before the debounce fires, "cat" is already stale
    calls[0]!.resolve(page(["cat1"]));
    await flush();
    expect(p.get()).toMatchObject({ query: "dog", phase: "loading", results: [] });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[1]!.resolve(page(["dog1"]));
    await flush();
    expect(p.get().results.map((r) => r.id)).toEqual(["dog1"]);
  });

  it("an error keeps the picker usable: retry asks again for the same query", async () => {
    const { api, calls } = fakeApi();
    const p = createGifPicker(api);
    p.setQuery("cat");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0]!.reject();
    await flush();
    expect(p.get().phase).toBe("error");
    p.retry();
    expect(calls[1]).toMatchObject({ kind: "search", q: "cat", offset: 0 });
    calls[1]!.resolve(page(["c1"]));
    await flush();
    expect(p.get()).toMatchObject({ phase: "ready", results: [gif("c1")] });
  });

  it("dispose cancels a pending search and ignores late answers", async () => {
    const { api, calls } = fakeApi();
    const p = createGifPicker(api);
    p.start();
    p.setQuery("cat");
    p.dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(page(["late"]));
    await flush();
    expect(p.get().results).toEqual([]);
  });
});

describe("gifBox", () => {
  it("scales a size hint into 320x240 without enlarging, and falls back for a missing hint", () => {
    expect(gifBox("https://i.giphy.com/a.gif#w=200&h=150")).toEqual({ width: 200, height: 150 });
    expect(gifBox("https://i.giphy.com/a.gif#w=640&h=360")).toEqual({ width: 320, height: 180 });
    expect(gifBox("https://i.giphy.com/a.gif#w=300&h=600")).toEqual({ width: 120, height: 240 });
    expect(gifBox("https://i.giphy.com/a.gif")).toEqual({ width: 240, height: 180 });
    expect(gifBox("https://i.giphy.com/a.gif#w=99999&h=1")).toEqual({ width: 240, height: 180 });
  });
});

describe("show-GIFs preference", () => {
  const storage = (initial?: string) => {
    const data = new Map<string, string>(initial ? [["loop.showGifs", initial]] : []);
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };
  it("defaults on, remembers off, and survives blocked storage", () => {
    expect(createFlagPref("loop.showGifs", () => storage()).get()).toBe(true);
    expect(createFlagPref("loop.showGifs", () => storage("off")).get()).toBe(false);
    const s = storage();
    const pref = createFlagPref("loop.showGifs", () => s);
    const seen = vi.fn();
    pref.subscribe(seen);
    pref.set(false);
    expect([pref.get(), s.data.get("loop.showGifs"), seen.mock.calls.length]).toEqual([false, "off", 1]);
    const blocked = () => ({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(createFlagPref("k", blocked).get()).toBe(true);
  });
});
