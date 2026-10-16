import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingJump, createSearch, foldText, highlight, hitKey, isFindShortcut, jumpPlan, normalizeQuery, searchPath, snippet } from "./search";

const GUILD = { kind: "guild", guildId: "g1" } as const;
const CH = "channel:c1" as const;
const DM = "dm:d1" as const;
const text = (parts: { text: string }[]) => parts.map((p) => p.text).join("");
const hits = (parts: { text: string; hit: boolean }[]) => parts.filter((p) => p.hit).map((p) => p.text);

describe("query validation", () => {
  it("trims, and refuses what the server would: empty, over 100 characters, or no word at all", () => {
    expect(normalizeQuery("  xin chào ")).toBe("xin chào");
    expect(normalizeQuery("")).toBeNull();
    expect(normalizeQuery("   ")).toBeNull();
    expect(normalizeQuery("x".repeat(101))).toBeNull();
    expect(normalizeQuery("x".repeat(100))).toBe("x".repeat(100));
    expect(normalizeQuery("!!! ??")).toBeNull();
    expect(normalizeQuery("a\0b")).toBeNull();
  });

  it("builds the path with the text escaped, and the paging cursor", () => {
    expect(searchPath(GUILD, "a&b=c d")).toBe("/guilds/g1/messages/search?q=a%26b%3Dc+d");
    expect(searchPath({ kind: "dm", dmId: "d1" }, "hi", "42")).toBe("/dms/d1/messages/search?q=hi&before=42");
  });

  it("Ctrl+F / Cmd+F only", () => {
    expect(isFindShortcut({ key: "f", ctrlKey: true })).toBe(true);
    expect(isFindShortcut({ key: "F", metaKey: true })).toBe(true);
    expect(isFindShortcut({ key: "f" })).toBe(false);
    expect(isFindShortcut({ key: "f", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isFindShortcut({ key: "k", ctrlKey: true })).toBe(false);
  });
});

describe("highlighting", () => {
  it("ignores case and accents, in both directions, and keeps the original letters", () => {
    expect(hits(highlight("Xin chào các bạn", "chao"))).toEqual(["chào"]);
    expect(hits(highlight("Đạt đã tới", "dat"))).toEqual(["Đạt"]);
    expect(hits(highlight("dat", "Đạt"))).toEqual(["dat"]);
    expect(text(highlight("Xin chào các bạn", "chao"))).toBe("Xin chào các bạn");
  });

  it("matches a word start (a prefix), never the middle of a word", () => {
    expect(hits(highlight("deploying redeploy", "deploy"))).toEqual(["deploy"]);
    expect(hits(highlight("hello world", "wor"))).toEqual(["wor"]);
  });

  it("marks every term, longest first, and decomposed (NFD) text too", () => {
    expect(hits(highlight("the server is down", "server down"))).toEqual(["server", "down"]);
    expect(hits(highlight("chào ban", "chào"))).toEqual(["chào"]);
  });

  it("is text only: markup stays inert, regex characters are harmless", () => {
    const parts = highlight("<b>bold</b> (a+b)", "b+ (a");
    expect(text(parts)).toBe("<b>bold</b> (a+b)");
    expect(highlight("anything", "(((")).toEqual([{ text: "anything", hit: false }]);
    expect(highlight("", "x")).toEqual([]);
  });

  it("foldText keeps the length of the text", () => {
    for (const s of ["Đạt Nguyễn ẩn", "ǆ ß ﬁ", "😀 emoji", "chào"]) expect(foldText(s).length).toBe(s.normalize("NFC").length);
  });
});

describe("snippet", () => {
  it("a short message is shown whole", () => {
    expect(text(snippet("hello world", "world"))).toBe("hello world");
  });

  it("a long one is cut around the first match with ellipses", () => {
    const long = `${"a".repeat(200)} needle ${"b".repeat(200)}`;
    const parts = snippet(long, "needle");
    expect(hits(parts)).toEqual(["needle"]);
    expect(text(parts).startsWith("...")).toBe(true);
    expect(text(parts).endsWith("...")).toBe(true);
    expect(text(parts).length).toBeLessThan(200);
  });

  it("a long message with no match in view starts at the beginning", () => {
    const parts = snippet("x".repeat(500), "zzz");
    expect(text(parts).startsWith("x")).toBe(true);
    expect(text(parts).endsWith("...")).toBe(true);
  });
});

describe("what choosing a result does", () => {
  it("scrolls when the message is loaded in the open conversation, says so when it is not, opens another conversation first", () => {
    expect(jumpPlan(CH, CH, true)).toBe("scroll");
    expect(jumpPlan(CH, CH, false)).toBe("outside");
    expect(jumpPlan(CH, DM, false)).toBe("open");
    expect(jumpPlan(CH, null, true)).toBe("open");
  });

  it("derives the conversation of a hit", () => {
    expect(hitKey({ channelId: "c1", dmChannelId: null })).toBe(CH);
    expect(hitKey({ channelId: null, dmChannelId: "d1" })).toBe(DM);
  });

  it("a pending jump is taken once, only by its own conversation", () => {
    const j = createPendingJump();
    j.set(CH, "m1");
    expect(j.take(DM)).toBeNull();
    expect(j.take(CH)).toBe("m1");
    expect(j.take(CH)).toBeNull();
    j.set(CH, "m2");
    j.clear();
    expect(j.take(CH)).toBeNull();
  });
});

describe("the results model", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const m = (seq: string) => ({ id: `m${seq}`, seq, content: `msg ${seq}`, channelId: "c1", dmChannelId: null });
  const make = (pages: { messages: unknown[]; hasMore: boolean }[]) => {
    const paths: string[] = [];
    const request = vi.fn(async (_method: string, path: string) => {
      paths.push(path);
      const page = pages.shift();
      if (!page) throw new Error("boom");
      return page;
    });
    return { s: createSearch({ request: request as never, scope: GUILD, delayMs: 300 }), paths };
  };

  it("searches after a typing pause, not on every key, and lands in ready", async () => {
    const { s, paths } = make([{ messages: [m("9")], hasMore: false }]);
    s.setQuery("n");
    s.setQuery("ne");
    s.setQuery("need");
    await vi.advanceTimersByTimeAsync(299);
    expect(paths).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(paths).toEqual(["/guilds/g1/messages/search?q=need"]);
    expect(s.store.getState()).toMatchObject({ status: "ready", hasMore: false, results: [{ id: "m9" }] });
  });

  it("an invalid or empty query goes idle without asking the server", async () => {
    const { s, paths } = make([]);
    s.setQuery("!!!");
    await vi.advanceTimersByTimeAsync(500);
    expect(paths).toEqual([]);
    expect(s.store.getState().status).toBe("idle");
  });

  it("submit searches at once; paging appends the next page after the last seq", async () => {
    const { s, paths } = make([
      { messages: [m("9"), m("8")], hasMore: true },
      { messages: [m("7")], hasMore: false },
    ]);
    s.setQuery("msg");
    await s.submit();
    await s.loadMore();
    expect(paths[1]).toBe("/guilds/g1/messages/search?q=msg&before=8");
    expect(s.store.getState().results.map((r) => r.id)).toEqual(["m9", "m8", "m7"]);
    expect(s.store.getState().hasMore).toBe(false);
    await s.loadMore(); // nothing more
    expect(paths).toHaveLength(2);
  });

  it("a failed search is an error state; a failed page keeps the results and says so", async () => {
    const { s } = make([]);
    s.setQuery("msg");
    await s.submit();
    expect(s.store.getState().status).toBe("error");

    const second = make([{ messages: [m("9")], hasMore: true }]);
    second.s.setQuery("msg");
    await second.s.submit();
    await second.s.loadMore();
    expect(second.s.store.getState()).toMatchObject({ status: "ready", moreFailed: true, loadingMore: false, results: [{ id: "m9" }] });
  });

  it("an answer that arrives after a newer search or a reset is ignored", async () => {
    let release!: (v: unknown) => void;
    const slow = new Promise((r) => (release = r));
    const request = vi.fn().mockReturnValueOnce(slow).mockResolvedValueOnce({ messages: [m("2")], hasMore: false });
    const s = createSearch({ request: request as never, scope: GUILD });
    s.setQuery("old");
    const first = s.submit();
    s.setQuery("new");
    await s.submit();
    release({ messages: [m("1")], hasMore: false });
    await first;
    expect(s.store.getState().results.map((r) => r.id)).toEqual(["m2"]);
    s.reset();
    expect(s.store.getState()).toMatchObject({ query: "", status: "idle", results: [] });
  });
});
