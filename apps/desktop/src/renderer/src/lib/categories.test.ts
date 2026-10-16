import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyGuildEvent, applyTree, buildTree, canShift, commitLayout, dropOn, layoutInFlight, layoutOf, moveChannel, reduceGuild, shiftCategory, shiftChannel, shownChannels, type GuildData, type GuildEvent } from "./categories";
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
  it("channel:updated merges the new name and topic, keeps overwrites and position, and is idempotent", () => {
    const held = data([{ ...ch("n", 3, "A"), overwrites: [{ roleId: "r", allow: 1, deny: 0 }] as never }]);
    const e = { type: "channel:updated", channel: { ...ch("n", 3, "A"), name: "moi", topic: "chủ đề" } } as const;
    const once = reduceGuild(held, e);
    expect(once.channels[0]).toMatchObject({ name: "moi", topic: "chủ đề", position: 3 });
    expect(once.channels[0]!.overwrites).toHaveLength(1);
    expect(reduceGuild(once, e).channels).toEqual(once.channels);
    expect(reduceGuild(once, { ...e, channel: { ...e.channel, topic: null } }).channels[0]!.topic).toBeNull();
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
  it("roles:updated refetches only the guild's roles (the event carries none)", () => {
    const qc = new QueryClient();
    qc.setQueryData(key, data([]));
    qc.setQueryData([...key, "roles"], []);
    qc.setQueryData([...key, "members"], []);
    applyGuildEvent(qc, { type: "roles:updated", guildId: G });
    expect(qc.getQueryState([...key, "roles"])!.isInvalidated).toBe(true);
    expect(qc.getQueryState([...key, "members"])!.isInvalidated).toBe(false);
    expect(qc.getQueryState(key)!.isInvalidated).toBe(false);
  });
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

describe("applyGuildEvent: channel:updated", () => {
  it("updates a known channel in place without a refetch; an unknown one refetches", () => {
    const qc = new QueryClient();
    const key = ["guild", G];
    qc.setQueryData(key, data([ch("known", 0, "A")]));
    applyGuildEvent(qc, { type: "channel:updated", channel: { ...ch("known", 0, "A"), name: "moi" } });
    expect(qc.getQueryData<GuildData>(key)!.channels[0]!.name).toBe("moi");
    expect(qc.getQueryState(key)!.isInvalidated).toBe(false);
    applyGuildEvent(qc, { type: "channel:updated", channel: ch("fresh", 1, "A") });
    expect(qc.getQueryState(key)!.isInvalidated).toBe(true);
  });
});

describe("dropOn (drag and drop rules)", () => {
  // loose: l1 l2 | A: a1 a2 | B: b1 | C: (empty)
  const tree = () => buildTree([ch("l1", 0, null), ch("l2", 1, null), ch("a1", 0, "A"), ch("a2", 1, "A"), ch("b1", 0, "B")], [cat("A", 0), cat("B", 1), cat("C", 2)]);
  const shape = (t: ReturnType<typeof tree> | null) => t && [ids(t.loose), ...t.groups.map((g) => ids(g.channels))];
  const chan = (id: string): { kind: "channel"; id: string } => ({ kind: "channel", id });
  const category = (id: string): { kind: "category"; id: string } => ({ kind: "category", id });
  const onChannel = (id: string, position: "before" | "after" | "inside") => ({ kind: "channel" as const, id, position });
  const onCategory = (id: string, position: "before" | "after" | "inside") => ({ kind: "category" as const, id, position });

  it("a category goes before or after another category", () => {
    expect(dropOn(tree(), category("C"), onCategory("A", "before"))!.groups.map((g) => g.category.id)).toEqual(["C", "A", "B"]);
    expect(dropOn(tree(), category("A"), onCategory("B", "after"))!.groups.map((g) => g.category.id)).toEqual(["B", "A", "C"]);
    expect(dropOn(tree(), category("A"), onCategory("C", "after"))!.groups.map((g) => g.category.id)).toEqual(["B", "C", "A"]);
  });
  it("a category never goes into a channel list or inside a category; onto itself or in place is a no-op", () => {
    expect(dropOn(tree(), category("A"), onChannel("b1", "after"))).toBeNull();
    expect(dropOn(tree(), category("A"), onCategory("B", "inside"))).toBeNull();
    expect(dropOn(tree(), category("A"), { kind: "loose", id: null, position: "inside" })).toBeNull();
    expect(dropOn(tree(), category("A"), onCategory("A", "before"))).toBeNull();
    expect(dropOn(tree(), category("A"), onCategory("B", "before"))).toBeNull(); // already right before B
    expect(dropOn(tree(), category("nope"), onCategory("A", "before"))).toBeNull();
  });
  it("a channel goes before/after another channel inside the same category", () => {
    expect(shape(dropOn(tree(), chan("a2"), onChannel("a1", "before")))).toEqual([["l1", "l2"], ["a2", "a1"], ["b1"], []]);
    expect(shape(dropOn(tree(), chan("a1"), onChannel("a2", "after")))).toEqual([["l1", "l2"], ["a2", "a1"], ["b1"], []]);
  });
  it("a channel dropped before/after a channel of another category adopts that category (start, middle, end)", () => {
    expect(shape(dropOn(tree(), chan("b1"), onChannel("a1", "before")))).toEqual([["l1", "l2"], ["b1", "a1", "a2"], [], []]);
    expect(shape(dropOn(tree(), chan("b1"), onChannel("a1", "after")))).toEqual([["l1", "l2"], ["a1", "b1", "a2"], [], []]);
    expect(shape(dropOn(tree(), chan("b1"), onChannel("a2", "after")))).toEqual([["l1", "l2"], ["a1", "a2", "b1"], [], []]);
  });
  it("a channel dropped on a header goes to the START of that category; an empty category takes it as its only item", () => {
    expect(shape(dropOn(tree(), chan("b1"), onCategory("A", "inside")))).toEqual([["l1", "l2"], ["b1", "a1", "a2"], [], []]);
    expect(shape(dropOn(tree(), chan("a1"), onCategory("C", "inside")))).toEqual([["l1", "l2"], ["a2"], ["b1"], ["a1"]]);
  });
  it("collapsed or not, a header drop is the same tree (it never expands: expanding is the view's state, not the tree's)", () => {
    const folded = dropOn(tree(), chan("l1"), onCategory("B", "inside"));
    expect(shape(folded)).toEqual([["l2"], ["a1", "a2"], ["l1", "b1"], []]);
  });
  it("to and from the uncategorised area", () => {
    expect(shape(dropOn(tree(), chan("a1"), { kind: "loose", id: null, position: "inside" }))).toEqual([["a1", "l1", "l2"], ["a2"], ["b1"], []]);
    expect(shape(dropOn(tree(), chan("a1"), onChannel("l2", "after")))).toEqual([["l1", "l2", "a1"], ["a2"], ["b1"], []]);
    expect(shape(dropOn(tree(), chan("l1"), onChannel("b1", "after")))).toEqual([["l2"], ["a1", "a2"], ["b1", "l1"], []]);
  });
  it("a channel onto itself, in place, with a missing id or an impossible position is null (no request)", () => {
    expect(dropOn(tree(), chan("a1"), onChannel("a1", "before"))).toBeNull();
    expect(dropOn(tree(), chan("a1"), onChannel("a2", "before"))).toBeNull(); // already right before a2
    expect(dropOn(tree(), chan("a1"), onCategory("A", "inside"))).toBeNull(); // already first in A
    expect(dropOn(tree(), chan("l1"), { kind: "loose", id: null, position: "inside" })).toBeNull();
    expect(dropOn(tree(), chan("a1"), onChannel("a2", "inside"))).toBeNull();
    expect(dropOn(tree(), chan("a1"), onCategory("A", "before"))).toBeNull();
    expect(dropOn(tree(), chan("a1"), onChannel("ghost", "after"))).toBeNull();
    expect(dropOn(tree(), chan("ghost"), onCategory("A", "inside"))).toBeNull();
  });
  it("never mutates the tree it was given", () => {
    const t = tree();
    dropOn(t, chan("a1"), onCategory("C", "inside"));
    expect(shape(t)).toEqual([["l1", "l2"], ["a1", "a2"], ["b1"], []]);
  });
});

describe("applyTree + commitLayout (optimistic update, rollback)", () => {
  const key = ["guild", G];
  const setup = () => {
    const qc = new QueryClient();
    const start = data([ch("a1", 0, "A"), ch("a2", 1, "A"), ch("b1", 0, "B")]);
    qc.setQueryData(key, start);
    const next = dropOn(buildTree(start.channels, start.categories), { kind: "channel", id: "a1" }, { kind: "category", id: "B", position: "inside" })!;
    return { qc, start, next };
  };
  const order = (qc: QueryClient) => {
    const d = qc.getQueryData<GuildData>(key)!;
    const t = buildTree(d.channels, d.categories);
    return t.groups.map((g) => ids(g.channels));
  };

  it("applyTree writes categories' and channels' category + position", () => {
    const { start, next } = setup();
    const moved = applyTree(start, next);
    expect(moved.channels.find((c) => c.id === "a1")).toMatchObject({ categoryId: "B", position: 0 });
    expect(moved.channels.find((c) => c.id === "b1")).toMatchObject({ categoryId: "B", position: 1 });
    expect(moved.channels.find((c) => c.id === "a2")).toMatchObject({ categoryId: "A", position: 0 });
  });
  it("shows the move before the PUT answers, sends the full layout, and keeps it on success", async () => {
    const { qc, next } = setup();
    let sent: unknown;
    let release!: () => void;
    const pending = commitLayout(qc, G, next, (l) => ((sent = l), new Promise<void>((r) => (release = r))));
    expect(order(qc)).toEqual([["a2"], ["a1", "b1"]]); // optimistic, request still in flight
    expect(layoutInFlight(G)).toBe(true);
    expect(sent).toEqual(layoutOf(next));
    release();
    await pending;
    expect(layoutInFlight(G)).toBe(false);
    expect(order(qc)).toEqual([["a2"], ["a1", "b1"]]);
  });
  it("a failing PUT rolls the cache back and rethrows (for the toast)", async () => {
    const { qc } = setup();
    const { next } = setup();
    await expect(commitLayout(qc, G, next, () => Promise.reject(new Error("409")))).rejects.toThrow("409");
    expect(order(qc)).toEqual([["a1", "a2"], ["b1"]]);
    expect(layoutInFlight(G)).toBe(false);
  });
  it("a refetch that already put the server's truth in the cache is not overwritten by the rollback", async () => {
    const { qc, next } = setup();
    const truth = data([ch("a2", 0, "A"), ch("b1", 0, "B"), ch("a1", 1, "B")]);
    await expect(commitLayout(qc, G, next, async () => { qc.setQueryData(key, truth); throw new Error("409"); })).rejects.toThrow();
    expect(qc.getQueryData(key)).toEqual(truth);
    expect(order(qc)).toEqual([["a2"], ["b1", "a1"]]);
  });
  it("a layout:updated from someone else is skipped while our PUT is in flight, applied afterwards", async () => {
    const { qc, next } = setup();
    const theirs: GuildEvent = { type: "layout:updated", event: { guildId: G, categories: [{ id: "A", position: 5 }, { id: "B", position: 0 }], channels: [] } };
    let release!: () => void;
    const pending = commitLayout(qc, G, next, () => new Promise<void>((r) => (release = r)));
    applyGuildEvent(qc, theirs);
    expect(qc.getQueryData<GuildData>(key)!.categories.find((c) => c.id === "A")!.position).toBe(0);
    release();
    await pending;
    applyGuildEvent(qc, theirs);
    expect(qc.getQueryData<GuildData>(key)!.categories.find((c) => c.id === "A")!.position).toBe(5);
  });
});
