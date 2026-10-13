import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyGuildEvent, buildTree, canShift, layoutOf, moveChannel, reduceGuild, shiftCategory, shiftChannel, shownChannels, type GuildData, type GuildEvent } from "./categories";
import type { Channel } from "./permissions";

const G = "g1";
const cat = (id: string, position: number, name = id) => ({ id, guildId: G, name, position, createdAt: "t" });
const ch = (id: string, position: number, categoryId: string | null, type: "TEXT" | "VOICE" = "TEXT"): Channel => ({ id, guildId: G, name: id, type, position, categoryId, overwrites: [] });
const ids = (l: { id: string }[]) => l.map((x) => x.id);
const data = (channels: Channel[], categories = [cat("A", 0), cat("B", 1)]): GuildData => ({ guild: { id: G, name: "g", ownerId: "o", createdAt: "t" }, channels, categories });

describe("buildTree", () => {
  it("puts uncategorised channels first, then categories by position, each with its channels by position (gaps are fine)", () => {
    const t = buildTree([ch("b2", 9, "B"), ch("a1", 4, "A"), ch("loose2", 7, null), ch("a0", 1, "A"), ch("loose1", 2, null), ch("b1", 3, "B")], [cat("B", 50), cat("A", 10)]);
    expect(ids(t.loose)).toEqual(["loose1", "loose2"]);
    expect(t.groups.map((g) => [g.category.id, ids(g.channels)])).toEqual([
      ["A", ["a0", "a1"]],
      ["B", ["b1", "b2"]],
    ]);
  });
  it("a channel whose category is unknown shows as uncategorised (never lost), ties are stable by id", () => {
    const t = buildTree([ch("z", 0, "gone"), ch("y", 0, null)], []);
    expect(ids(t.loose)).toEqual(["y", "z"]);
  });
});

describe("shownChannels (a folded category keeps only what the user is in)", () => {
  const list = [ch("t1", 0, "A"), ch("t2", 1, "A"), ch("v1", 2, "A", "VOICE")];
  const keep = (c: Channel) => c.id === "t2" || c.id === "v1";
  it("expanded shows all, folded shows the open text channel and the joined voice channel only", () => {
    expect(ids(shownChannels(list, false, keep))).toEqual(["t1", "t2", "v1"]);
    expect(ids(shownChannels(list, true, keep))).toEqual(["t2", "v1"]);
    expect(shownChannels(list, true, () => false)).toEqual([]);
  });
});

describe("layoutOf", () => {
  it("lists ALL categories in order and ALL channels (loose first, then per category) with their category", () => {
    const t = buildTree([ch("a1", 0, "A"), ch("l", 0, null), ch("b1", 0, "B"), ch("a2", 1, "A")], [cat("A", 0), cat("B", 1), cat("C", 2)]);
    expect(layoutOf(t)).toEqual({
      categories: ["A", "B", "C"],
      channels: [
        { id: "l", categoryId: null },
        { id: "a1", categoryId: "A" },
        { id: "a2", categoryId: "A" },
        { id: "b1", categoryId: "B" },
      ],
    });
  });
});

describe("moves", () => {
  const tree = () => buildTree([ch("a1", 0, "A"), ch("a2", 1, "A"), ch("b1", 0, "B"), ch("l", 0, null)], [cat("A", 0), cat("B", 1)]);
  it("moveChannel appends to the target category (or the loose area) and keeps every channel exactly once", () => {
    expect(layoutOf(moveChannel(tree(), "a1", "B")).channels).toEqual([
      { id: "l", categoryId: null },
      { id: "a2", categoryId: "A" },
      { id: "b1", categoryId: "B" },
      { id: "a1", categoryId: "B" },
    ]);
    expect(layoutOf(moveChannel(tree(), "b1", null)).channels.map((c) => c.id)).toEqual(["l", "b1", "a1", "a2"]);
    expect(moveChannel(tree(), "nope", "B")).toEqual(tree());
  });
  it("shiftChannel swaps with the neighbour inside its own category only; at the ends nothing changes", () => {
    expect(layoutOf(shiftChannel(tree(), "a2", -1)).channels.map((c) => c.id)).toEqual(["l", "a2", "a1", "b1"]);
    const t = tree();
    expect(shiftChannel(t, "a1", -1)).toEqual(t);
    expect(canShift(t.groups[0]!.channels, "a1", -1)).toBe(false);
    expect(canShift(t.groups[0]!.channels, "a1", 1)).toBe(true);
  });
  it("shiftCategory reorders the categories", () => {
    expect(layoutOf(shiftCategory(tree(), "B", -1)).categories).toEqual(["B", "A"]);
    expect(layoutOf(shiftCategory(tree(), "B", 1)).categories).toEqual(["A", "B"]);
  });
});

describe("reduceGuild (realtime events, applied by id)", () => {
  it("channel:created adds it once: our own echo and a duplicate only merge", () => {
    const e = { type: "channel:created", channel: { ...ch("n", 3, "A"), overwrites: undefined as never } } as const;
    const once = reduceGuild(data([ch("a", 0, "A")]), e);
    expect(ids(once.channels)).toEqual(["a", "n"]);
    expect(once.channels[1]!.overwrites).toEqual([]);
    expect(ids(reduceGuild(once, e).channels)).toEqual(["a", "n"]);
    // the echo does not wipe overwrites we already hold
    const held = data([{ ...ch("n", 3, "A"), overwrites: [{ roleId: "r", allow: 1, deny: 0 }] as never }]);
    expect(reduceGuild(held, e).channels[0]!.overwrites).toHaveLength(1);
  });
  it("category:created / updated upsert by id (a late 'created' after 'updated' does not duplicate)", () => {
    let d = reduceGuild(data([]), { type: "category:created", category: cat("C", 2, "Mới") });
    d = reduceGuild(d, { type: "category:updated", category: cat("C", 2, "Đổi tên") });
    d = reduceGuild(d, { type: "category:created", category: cat("C", 2, "Đổi tên") });
    expect(d.categories.filter((c) => c.id === "C")).toEqual([cat("C", 2, "Đổi tên")]);
  });
  it("category:deleted removes it and moves its channels out with the new positions; repeated is harmless", () => {
    const d0 = data([ch("l", 0, null), ch("a1", 0, "A"), ch("a2", 1, "A"), ch("b1", 0, "B")]);
    const e: GuildEvent = { type: "category:deleted", event: { guildId: G, categoryId: "A", channels: [{ id: "a1", categoryId: null, position: 1 }, { id: "a2", categoryId: null, position: 2 }] } };
    const d = reduceGuild(d0, e);
    expect(ids(d.categories)).toEqual(["B"]);
    expect(buildTree(d.channels, d.categories).loose.map((c) => c.id)).toEqual(["l", "a1", "a2"]);
    expect(reduceGuild(d, e)).toEqual(d);
  });
  it("category:deleted also frees a channel of that category the event did not name (hidden from someone else)", () => {
    const d = reduceGuild(data([ch("a1", 0, "A")]), { type: "category:deleted", event: { guildId: G, categoryId: "A", channels: [] } });
    expect(d.channels[0]!.categoryId).toBeNull();
  });
  it("layout:updated sets category and channel positions, ignores unknown ids and tolerates gaps", () => {
    const d0 = data([ch("a1", 0, "A"), ch("a2", 1, "A"), ch("b1", 0, "B")]);
    const d = reduceGuild(d0, {
      type: "layout:updated",
      event: { guildId: G, categories: [{ id: "B", position: 0 }, { id: "A", position: 1 }, { id: "ghost", position: 2 }], channels: [{ id: "a2", categoryId: "B", position: 5 }, { id: "a1", categoryId: "A", position: 0 }, { id: "ghost", categoryId: null, position: 0 }] },
    });
    expect(d.categories).toHaveLength(2);
    const t = buildTree(d.channels, d.categories);
    expect(t.groups.map((g) => [g.category.id, ids(g.channels)])).toEqual([
      ["B", ["b1", "a2"]],
      ["A", ["a1"]],
    ]);
  });
  it("the same layout event twice gives the same state", () => {
    const e: GuildEvent = { type: "layout:updated", event: { guildId: G, categories: [{ id: "A", position: 1 }], channels: [{ id: "a1", categoryId: null, position: 3 }] } };
    const once = reduceGuild(data([ch("a1", 0, "A")]), e);
    expect(reduceGuild(once, e)).toEqual(once);
  });
});

describe("applyGuildEvent (the cache)", () => {
  const key = ["guild", G];
  it("updates the loaded guild in place, leaves an unloaded one alone", () => {
    const qc = new QueryClient();
    applyGuildEvent(qc, { type: "category:created", category: cat("C", 2) });
    expect(qc.getQueryData(key)).toBeUndefined();
    qc.setQueryData(key, data([]));
    applyGuildEvent(qc, { type: "category:created", category: cat("C", 2) });
    expect(ids(qc.getQueryData<GuildData>(key)!.categories)).toEqual(["A", "B", "C"]);
  });
  it("a channel we did not know refetches (overwrites are not in the event); our own echo does not", () => {
    const qc = new QueryClient();
    qc.setQueryData(key, data([ch("known", 0, "A")]));
    applyGuildEvent(qc, { type: "channel:created", channel: ch("known", 0, "A") });
    expect(qc.getQueryState(key)!.isInvalidated).toBe(false);
    applyGuildEvent(qc, { type: "channel:created", channel: ch("fresh", 1, "A") });
    expect(qc.getQueryState(key)!.isInvalidated).toBe(true);
    expect(ids(qc.getQueryData<GuildData>(key)!.channels)).toEqual(["known", "fresh"]);
  });
});
