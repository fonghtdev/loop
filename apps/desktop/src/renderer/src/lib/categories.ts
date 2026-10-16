import type { Category, CategoryDeletedEvent, Layout, LayoutUpdatedEvent } from "@loop/shared";
import type { QueryClient } from "@tanstack/react-query";
import type { Channel, Guild } from "./permissions";

/** GET /guilds/:id. The channels are the ones we may see; positions order a channel inside its category only. */
export type GuildData = { guild: Guild; channels: Channel[]; categories: Category[] };
export type { Category };

// ---- the render tree: pure, so the later drag and drop edits the same shape and sends `layoutOf(tree)` ----

type Placed = { id: string; position: number };
export type Group<C = Channel> = { category: Category; channels: C[] };
/** `loose` = channels with no (known) category, shown first without a header. */
export type Tree<C = Channel> = { loose: C[]; groups: Group<C>[] };

// positions may have gaps and are not unique: always sort, the id breaks ties so the order is stable
const byPosition = (a: Placed, b: Placed) => a.position - b.position || (a.id < b.id ? -1 : 1);

export function buildTree<C extends Placed & { categoryId: string | null }>(channels: C[], categories: Category[]): Tree<C> {
  const known = new Set(categories.map((c) => c.id));
  const sorted = [...channels].sort(byPosition);
  return {
    loose: sorted.filter((c) => !c.categoryId || !known.has(c.categoryId)),
    groups: [...categories].sort(byPosition).map((category) => ({ category, channels: sorted.filter((c) => c.categoryId === category.id) })),
  };
}

/**
 * What a collapsed category still shows: only the channels `keep` says (the open text channel, the voice channel we
 * are in), so the selection never disappears. An expanded category shows everything.
 */
export const shownChannels = <C>(channels: C[], collapsed: boolean, keep: (c: C) => boolean) => (collapsed ? channels.filter(keep) : channels);

/** The channels in the order the list shows them (the default channel of a server is the first text one here). */
export const displayOrder = <C>(tree: Tree<C>): C[] => [...tree.loose, ...tree.groups.flatMap((g) => g.channels)];

/** The PUT /layout body for a tree: ALL categories and ALL our channels, loose ones first. */
export function layoutOf(tree: Tree<{ id: string }>): Layout {
  const place = (categoryId: string | null) => (c: { id: string }) => ({ id: c.id, categoryId });
  return {
    categories: tree.groups.map((g) => g.category.id),
    channels: [...tree.loose.map(place(null)), ...tree.groups.flatMap((g) => g.channels.map(place(g.category.id)))],
  };
}

type Idd = { id: string };
const without = <T extends Idd>(list: T[], id: string) => list.filter((x) => x.id !== id);
/** Swaps the item `is` matches with its neighbour; the SAME array when there is none. */
function shifted<T>(list: T[], is: (x: T) => boolean, by: -1 | 1): T[] {
  const i = list.findIndex(is);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
/** Whether the item has a neighbour in that direction (the menu shows Lên/Xuống only then). */
export const canShift = (list: Idd[], id: string, by: -1 | 1) => shifted(list, (x) => x.id === id, by) !== list;

/** Moves a channel to the end of `categoryId` (null = uncategorised). */
export function moveChannel<C extends Idd>(tree: Tree<C>, channelId: string, categoryId: string | null): Tree<C> {
  const moving = [tree.loose, ...tree.groups.map((g) => g.channels)].flat().find((c) => c.id === channelId);
  if (!moving) return tree;
  return {
    loose: categoryId === null ? [...without(tree.loose, channelId), moving] : without(tree.loose, channelId),
    groups: tree.groups.map((g) => ({ ...g, channels: g.category.id === categoryId ? [...without(g.channels, channelId), moving] : without(g.channels, channelId) })),
  };
}

/** One step up/down among the channels of the same category (or among the loose ones). */
export function shiftChannel<C extends Idd>(tree: Tree<C>, channelId: string, by: -1 | 1): Tree<C> {
  const is = (c: C) => c.id === channelId;
  return { loose: shifted(tree.loose, is, by), groups: tree.groups.map((g) => ({ ...g, channels: shifted(g.channels, is, by) })) };
}

export const shiftCategory = <C>(tree: Tree<C>, categoryId: string, by: -1 | 1): Tree<C> => ({ ...tree, groups: shifted(tree.groups, (g) => g.category.id === categoryId, by) });

export const groupIds = (tree: Tree<unknown>) => tree.groups.map((g) => ({ id: g.category.id }));

// ---- drag and drop: the pure rules, then the optimistic commit ----

export type DragSource = { kind: "channel" | "category"; id: string };
/**
 * Where a drag ends. `loose` is the uncategorised area (id null). `inside` = the FIRST place of a category / the
 * uncategorised area, so a header, a collapsed category (it stays collapsed) and an empty category all work the same.
 */
export type DropTarget = { kind: "channel" | "category" | "loose"; id: string | null; position: "before" | "after" | "inside" };

const sameLayout = (a: Tree<Idd>, b: Tree<Idd>) => JSON.stringify(layoutOf(a)) === JSON.stringify(layoutOf(b));
const putAt = <T>(list: T[], i: number, item: T) => [...list.slice(0, i), item, ...list.slice(i)];

function dropCategory<C>(tree: Tree<C>, id: string, t: DropTarget): Tree<C> | null {
  const moving = tree.groups.find((g) => g.category.id === id);
  if (!moving || t.kind !== "category" || t.position === "inside" || t.id === id) return null; // never into a channel list
  const rest = tree.groups.filter((g) => g !== moving);
  const at = rest.findIndex((g) => g.category.id === t.id);
  return at < 0 ? null : { ...tree, groups: putAt(rest, at + (t.position === "after" ? 1 : 0), moving) };
}

function dropChannel<C extends Idd>(tree: Tree<C>, id: string, t: DropTarget): Tree<C> | null {
  const moving = [...tree.loose, ...tree.groups.flatMap((g) => g.channels)].find((c) => c.id === id);
  if (!moving) return null;
  const rest: Tree<C> = { loose: without(tree.loose, id), groups: tree.groups.map((g) => ({ ...g, channels: without(g.channels, id) })) };
  if (t.kind === "loose") return t.position === "inside" ? { ...rest, loose: putAt(rest.loose, 0, moving) } : null;
  if (t.kind === "category") {
    if (t.position !== "inside" || !rest.groups.some((g) => g.category.id === t.id)) return null;
    return { ...rest, groups: rest.groups.map((g) => (g.category.id === t.id ? { ...g, channels: putAt(g.channels, 0, moving) } : g)) };
  }
  if (t.position === "inside" || t.id === id) return null;
  // before/after another channel: it adopts that channel's category (or the uncategorised area)
  const at = (list: C[]) => {
    const i = list.findIndex((c) => c.id === t.id);
    return i < 0 ? -1 : i + (t.position === "after" ? 1 : 0);
  };
  if (at(rest.loose) >= 0) return { ...rest, loose: putAt(rest.loose, at(rest.loose), moving) };
  const home = rest.groups.findIndex((g) => at(g.channels) >= 0);
  if (home < 0) return null;
  return { ...rest, groups: rest.groups.map((g, i) => (i === home ? { ...g, channels: putAt(g.channels, at(g.channels), moving) } : g)) };
}

/** The tree after a drop, or null when nothing would change (onto itself, an unknown id, a forbidden target, a no-op): then no request. */
export function dropOn<C extends Idd>(tree: Tree<C>, source: DragSource, target: DropTarget): Tree<C> | null {
  const next = source.kind === "category" ? dropCategory(tree, source.id, target) : dropChannel(tree, source.id, target);
  return next && !sameLayout(tree, next) ? next : null;
}

/** The cached guild with the tree's order written into the positions (what the server will answer after the PUT). */
export function applyTree(data: GuildData, tree: Tree<Idd>): GuildData {
  const place = new Map<string, { categoryId: string | null; position: number }>();
  tree.loose.forEach((c, position) => place.set(c.id, { categoryId: null, position }));
  tree.groups.forEach((g) => g.channels.forEach((c, position) => place.set(c.id, { categoryId: g.category.id, position })));
  const index = new Map(tree.groups.map((g, i) => [g.category.id, i]));
  return {
    ...data,
    categories: data.categories.map((c) => ({ ...c, position: index.get(c.id) ?? c.position })),
    channels: data.channels.map((c) => ({ ...c, ...place.get(c.id) })),
  };
}

// One drop at a time per guild: a new drag is refused while its PUT (and the refetch after it) is running, and the
// realtime `layout:updated` is skipped meanwhile (the refetch brings the truth, our own echo included).
const inFlight = new Set<string>();
export const layoutInFlight = (guildId: string) => inFlight.has(guildId);

/**
 * Shows `next` at once, sends it, and on failure puts the old data back (unless a refetch already replaced our guess
 * with the server's truth, which must not be overwritten). Rethrows so the caller can toast.
 */
export async function commitLayout(qc: QueryClient, guildId: string, next: Tree<Idd>, send: (layout: Layout) => Promise<unknown>) {
  const key = ["guild", guildId];
  const before = qc.getQueryData<GuildData>(key);
  const guess = before && qc.setQueryData<GuildData>(key, applyTree(before, next)); // the stored object: a refetch replaces it
  inFlight.add(guildId);
  try {
    await send(layoutOf(next));
  } catch (err) {
    if (before && qc.getQueryData(key) === guess) qc.setQueryData(key, before);
    throw err;
  } finally {
    inFlight.delete(guildId);
  }
}

// ---- realtime: each event is applied by id and idempotently, so an echo, a duplicate or a late one cannot corrupt the cache ----

export type GuildEvent =
  | { type: "channel:created"; channel: Omit<Channel, "overwrites"> }
  | { type: "channel:updated"; channel: Omit<Channel, "overwrites"> }
  | { type: "category:created"; category: Category }
  | { type: "category:updated"; category: Category }
  | { type: "category:deleted"; event: CategoryDeletedEvent }
  | { type: "layout:updated"; event: LayoutUpdatedEvent }
  | { type: "roles:updated"; guildId: string };

const upsert = <T extends Idd>(list: T[], item: T, merge: (old: T) => T): T[] =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? merge(x) : x)) : [...list, item];

/** The new guild data after one event (unknown ids are ignored: the next fetch brings them). Order is never stored, only positions. */
export function reduceGuild(data: GuildData, e: GuildEvent): GuildData {
  switch (e.type) {
    case "roles:updated":
      return data; // nothing of GuildData; applyGuildEvent refetches the roles
    case "channel:created":
    case "channel:updated":
      return { ...data, channels: upsert(data.channels, { ...e.channel, overwrites: [] }, (old) => ({ ...old, ...e.channel, overwrites: old.overwrites })) };
    case "category:created":
    case "category:updated":
      return { ...data, categories: upsert(data.categories, e.category, (old) => ({ ...old, ...e.category })) };
    case "category:deleted": {
      const at = new Map(e.event.channels.map((c) => [c.id, c]));
      return {
        ...data,
        categories: without(data.categories, e.event.categoryId),
        // the ones the event names moved out; the rest of the category (hidden from that person) are not ours to show
        channels: data.channels.map((c) => (at.has(c.id) ? { ...c, categoryId: null, position: at.get(c.id)!.position } : c.categoryId === e.event.categoryId ? { ...c, categoryId: null } : c)),
      };
    }
    case "layout:updated": {
      const cat = new Map(e.event.categories.map((c) => [c.id, c.position]));
      const ch = new Map(e.event.channels.map((c) => [c.id, c]));
      return {
        ...data,
        categories: data.categories.map((c) => (cat.has(c.id) ? { ...c, position: cat.get(c.id)! } : c)),
        channels: data.channels.map((c) => (ch.has(c.id) ? { ...c, categoryId: ch.get(c.id)!.categoryId, position: ch.get(c.id)!.position } : c)),
      };
    }
  }
}

const guildIdOf = (e: Exclude<GuildEvent, { type: "roles:updated" }>) => (e.type === "channel:created" || e.type === "channel:updated" ? e.channel.guildId : e.type === "category:created" || e.type === "category:updated" ? e.category.guildId : e.event.guildId);

/** Applies a socket event to the guild's cache; a guild not loaded yet is left to its first fetch. A channel we did not know also refetches (its overwrites are not in the event). */
export function applyGuildEvent(qc: QueryClient, e: GuildEvent) {
  // the event carries no roles: refetch them (positions changed, so who outranks whom did)
  if (e.type === "roles:updated") return void qc.invalidateQueries({ queryKey: ["guild", e.guildId, "roles"] });
  const key = ["guild", guildIdOf(e)];
  const before = qc.getQueryData<GuildData>(key);
  if (!before || (e.type === "layout:updated" && inFlight.has(e.event.guildId))) return;
  qc.setQueryData<GuildData>(key, reduceGuild(before, e));
  if ((e.type === "channel:created" || e.type === "channel:updated") && !before.channels.some((c) => c.id === e.channel.id)) void qc.invalidateQueries({ queryKey: key });
}
