import { describe, expect, it } from "vitest";
import { flatten, match, normalize, searchGroups, TIER, type Kind, type Searchable } from "./quick-switch";

const item = (kind: Kind, name: string, scope?: string): Searchable => ({ kind, name, scope });
const names = (items: Searchable[], q: string, recents: Searchable[] = []) => flatten(searchGroups(items, q, { recents })).map((r) => r.item.name);
const ranges = (name: string, q: string, kind: Kind = "server") => flatten(searchGroups([item(kind, name)], q))[0]?.ranges;

describe("normalize", () => {
  it("folds case, diacritics, đ and whitespace", () => {
    expect(normalize("  Đà   Nẵng ")).toBe("da nang");
    expect(normalize("đạt")).toBe("dat");
    expect(normalize("Chúng")).toBe(normalize("chung"));
    expect(normalize("Đ")).toBe("d");
  });
  it("treats a decomposed letter (base + combining mark) like the composed one", () => {
    expect(normalize("chúng")).toBe("chung");
  });
});

describe("match tiers", () => {
  const order = (q: string, ...targets: string[]) => targets.map((t) => match(q, t)!.tier);
  it("exact > prefix > word start > substring > subsequence", () => {
    expect(order("ab", "ab", "abc", "x ab", "xabx", "a-x-b")).toEqual([TIER.exact, TIER.prefix, TIER.wordStart, TIER.substring, TIER.subsequence]);
  });
  it("a tier always beats a better-looking lower tier; inside a tier shorter and earlier win", () => {
    const long = match("ab", "ab" + "x".repeat(90))!.score; // longest possible prefix match
    expect(long).toBeGreaterThan(match("ab", "x ab")!.score);
    expect(match("ab", "abc")!.score).toBeGreaterThan(match("ab", "abcdef")!.score);
    expect(match("ab", "xab")!.score).toBeGreaterThan(match("ab", "xxxab")!.score);
  });
  it("penalises gaps in a subsequence and rejects out-of-order letters", () => {
    expect(match("abc", "a1b2c")!.score).toBeGreaterThan(match("abc", "a111b111c")!.score);
    expect(match("ba", "ab")).toBeNull();
  });
});

describe("searchGroups", () => {
  it("finds without diacritics both ways (chung <-> chúng, dat <-> đạt)", () => {
    expect(names([item("channel", "chung"), item("server", "Chúng ta")], "chúng").sort()).toEqual(["Chúng ta", "chung"]);
    expect(names([item("dm", "đạt")], "dat")).toEqual(["đạt"]);
    expect(names([item("server", "Đà Nẵng")], "da nang")).toEqual(["Đà Nẵng"]);
  });
  it("maps ranges back to the ORIGINAL string (accents, đ, decomposed letters, collapsed spaces)", () => {
    expect(ranges("Chúng ta", "ung")).toEqual([[2, 5]]);
    expect(ranges("Đà Nẵng", "nang")).toEqual([[3, 7]]);
    expect(ranges("Đà Nẵng", "dan")).toEqual([
      [0, 2],
      [3, 4],
    ]); // a subsequence skips the space
    expect(ranges("a   b", "b")).toEqual([[4, 5]]); // the collapsed spaces do not shift later indices
  });
  it("highlights a decomposed letter together with its mark", () => {
    const name = "chúng"; // 6 UTF-16 units
    expect(ranges(name, "chung")).toEqual([[0, 6]]);
    expect(ranges(name, "u")).toEqual([[2, 4]]);
  });
  it("highlight ranges are index pairs inside the name (text only, nothing to inject)", () => {
    const name = "<b>x</b>";
    for (const [a, b] of ranges(name, "bx")!) expect(name.slice(a, b)).toMatch(/^[<>/bx]+$/);
  });
  it("groups in the fixed order, best first inside a group, empty groups hidden", () => {
    const items = [item("place", "Home"), item("friend", "an"), item("dm", "an"), item("channel", "x an"), item("channel", "an-b"), item("server", "xx")];
    const g = searchGroups(items, "an");
    expect(g.map((x) => x.kind)).toEqual(["dm", "channel", "friend"]); // dm/friend "an" are exact: the dm group leads
    expect(g.find((x) => x.kind === "channel")!.rows.map((r) => r.item.name)).toEqual(["an-b", "x an"]);
  });
  it("an exact name match lifts its group; otherwise the order is fixed", () => {
    const items = [item("server", "alpha beta"), item("dm", "alpha")];
    expect(searchGroups(items, "alpha").map((g) => g.kind)).toEqual(["dm", "server"]);
    expect(searchGroups(items, "alph").map((g) => g.kind)).toEqual(["server", "dm"]);
  });
  it("ties are stable by name", () => {
    expect(names([item("dm", "bo"), item("dm", "ba"), item("dm", "bc")], "b")).toEqual(["ba", "bc", "bo"]);
  });
  it("a channel is found by its server name too, but below name matches", () => {
    const items = [item("channel", "general", "Chúng ta"), item("channel", "chung")];
    expect(names(items, "chung")).toEqual(["chung", "general"]);
  });
  it("empty query: the recents; without recents the first few of every kind", () => {
    const a = item("dm", "a");
    expect(searchGroups([a, item("dm", "b")], "  ", { recents: [a] }).map((g) => [g.kind, g.rows.length])).toEqual([["recent", 1]]);
    const many = Array.from({ length: 9 }, (_, i) => item("channel", `c${i}`));
    expect(searchGroups(many, "").map((g) => [g.kind, g.rows.length])).toEqual([["channel", 5]]);
  });
  it("renders at most 50 rows, keeping the leading groups", () => {
    const items = [item("server", "s"), ...Array.from({ length: 80 }, (_, i) => item("channel", `s${i}`))];
    const rows = flatten(searchGroups(items, "s"));
    expect(rows).toHaveLength(50);
    expect(rows[0].item.kind).toBe("server");
  });
  it("filters 2000 items in well under 10 ms (cold: includes normalizing their names)", () => {
    const words = ["chung", "Chúng ta", "đạt", "Đà Nẵng", "general", "voice-room", "Nguyễn Văn"];
    const items = Array.from({ length: 2000 }, (_, i) => item(i % 3 ? "channel" : "dm", `${words[i % words.length]} ${i}`, i % 2 ? "Máy chủ lớn" : undefined));
    const t0 = performance.now();
    searchGroups(items, "chung 1");
    const cold = performance.now() - t0;
    const t1 = performance.now();
    searchGroups(items, "dat");
    expect(cold).toBeLessThan(40);
    expect(performance.now() - t1).toBeLessThan(10);
  });
});
