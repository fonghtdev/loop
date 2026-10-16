import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MessageEmbed } from "@loop/shared";
import { API_URL } from "../../../shared/config";
import { createEmbedHides, createLinkPreviewPref, embedCards, embedKey, hostOf } from "./embeds";

const ID = "00000000-0000-4000-8000-000000000001";
const e = (over: Partial<MessageEmbed> = {}): MessageEmbed => ({ url: "https://www.news.example/a", siteName: "News", title: "Title", description: "Text", thumbnail: `/embeds/${ID}/thumbnail`, ...over });
const on = { enabled: true, hidden: new Set<string>() };

describe("embedCards", () => {
  it("builds cards with the thumbnail on the API origin", () => {
    expect(embedCards("m1", [e()], on)).toEqual([
      { key: embedKey("m1", "https://www.news.example/a"), url: "https://www.news.example/a", siteName: "News", title: "Title", description: "Text", thumbnail: `${API_URL}/embeds/${ID}/thumbnail` },
    ]);
  });
  it("shows nothing when the setting is off", () => {
    expect(embedCards("m1", [e()], { ...on, enabled: false })).toEqual([]);
  });
  it("leaves out a card closed for THIS message only", () => {
    const hidden = new Set([embedKey("m1", e().url)]);
    expect(embedCards("m1", [e(), e({ url: "https://b.example/" })], { enabled: true, hidden }).map((c) => c.url)).toEqual(["https://b.example/"]);
    expect(embedCards("m2", [e()], { enabled: true, hidden })).toHaveLength(1);
  });
  it("falls back to the host for the site name; refuses odd URLs, odd thumbnail paths and empty cards", () => {
    const [card] = embedCards("m1", [e({ siteName: null, thumbnail: "https://evil.example/x.png" })], on);
    expect(card).toMatchObject({ siteName: "news.example", thumbnail: null });
    expect(embedCards("m1", [e({ url: "javascript:alert(1)" }), e({ title: null, description: null }), e({ thumbnail: "/embeds/../x" })], on)).toEqual([expect.objectContaining({ thumbnail: null })]);
    expect(embedCards("m1", undefined, on)).toEqual([]);
  });
  it("hostOf", () => {
    expect([hostOf("https://www.a.example/x"), hostOf("http://b.example:8080/"), hostOf("nope")]).toEqual(["a.example", "b.example", ""]);
  });
});

describe("local state", () => {
  const storage = (initial?: string) => {
    const data = new Map<string, string>(initial ? [["loop.linkPreviews", initial]] : []);
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };
  it("the setting defaults to on, persists, survives broken storage", () => {
    expect(createLinkPreviewPref(() => storage()).get()).toBe(true);
    expect(createLinkPreviewPref(() => storage("off")).get()).toBe(false);
    const s = storage();
    const pref = createLinkPreviewPref(() => s);
    let calls = 0;
    pref.subscribe(() => calls++);
    pref.set(false);
    expect([pref.get(), s.data.get("loop.linkPreviews"), calls]).toEqual([false, "off", 1]);
    const broken = createLinkPreviewPref(() => ({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }));
    expect(broken.get()).toBe(true);
    broken.set(false);
    expect(broken.get()).toBe(false);
  });
  it("hiding a card is a new set (React sees the change)", () => {
    const hides = createEmbedHides();
    const before = hides.get();
    hides.hide("k");
    expect(hides.get()).not.toBe(before);
    expect(hides.get().has("k")).toBe(true);
  });
});

describe("MessageEmbeds component (source)", () => {
  const src = readFileSync(new URL("../components/MessageEmbeds.tsx", import.meta.url), "utf8");
  it("clamps the description, loads the thumbnail lazily in a fixed box, opens through openExternal", () => {
    expect(src).toContain("line-clamp-3");
    expect(src).toMatch(/loading="lazy"/);
    expect(src).toMatch(/size-20/);
    expect(src).toContain("openExternal");
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
});
