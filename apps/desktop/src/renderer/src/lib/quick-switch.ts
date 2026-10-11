/**
 * The quick switcher's matcher: diacritics-insensitive fuzzy search with highlight ranges and grouping. Pure.
 *
 * `normalize` lowercases, strips combining marks (NFD), folds đ to d and collapses whitespace, so "đạt", "Đà Nẵng" and
 * "chung" / "chúng" match each other. Every normalized unit remembers the span of the ORIGINAL character it came from, so
 * match positions map back to the original string for highlighting (a character that decomposes into several code
 * points, or a base letter followed by a loose combining mark, still highlights as one piece).
 */

export type Range = [start: number, end: number];
export const KIND_ORDER = ["server", "channel", "dm", "friend", "place"] as const;
export type Kind = (typeof KIND_ORDER)[number];
/** What the matcher needs from a thing to jump to. `scope` (a channel's server name) is searched too, but weaker. */
export type Searchable = { kind: Kind; name: string; scope?: string };

type Mapped = { text: string; from: number[]; to: number[] };

const ASCII = /^[\x20-\x7e]*$/;
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function normalizeMapped(s: string): Mapped {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of s) {
    const start = i;
    i += ch.length;
    const n = ch.normalize("NFD").toLowerCase().replace(/\p{M}/gu, "").replace(/đ/g, "d");
    if (n === "") {
      if (to.length) to[to.length - 1] = i; // a loose combining mark belongs to the letter before it
    } else if (/^\s+$/.test(n)) {
      if (text !== "" && !text.endsWith(" ")) {
        text += " ";
        from.push(start);
        to.push(i);
      }
    } else
      for (let k = 0; k < n.length; k++) {
        text += n[k];
        from.push(start);
        to.push(i);
      }
  }
  if (text.endsWith(" ")) return { text: text.slice(0, -1), from: from.slice(0, -1), to: to.slice(0, -1) };
  return { text, from, to };
}

export function normalize(s: string): string {
  return ASCII.test(s) ? collapse(s.toLowerCase()) : normalizeMapped(s).text;
}

/** Normalized positions merged into ranges of the original string. */
function toRanges(m: Mapped, positions: number[]): Range[] {
  const out: Range[] = [];
  for (const p of positions) {
    const last = out[out.length - 1];
    if (last && m.from[p] <= last[1]) last[1] = Math.max(last[1], m.to[p]);
    else out.push([m.from[p], m.to[p]]);
  }
  return out;
}

export const TIER = { scope: 0, subsequence: 1, substring: 2, wordStart: 3, prefix: 4, exact: 5 } as const;
type Match = { tier: number; score: number; positions: number[] };

const run = (start: number, len: number) => Array.from({ length: len }, (_, k) => start + k);
const isBoundary = (t: string, i: number) => i === 0 || /[^a-z0-9]/.test(t[i - 1]);
/** A tier sets the order; inside it earlier matches, tighter matches and shorter targets rank higher (never crossing tiers). */
const scored = (tier: number, at: number, gaps: number, len: number) => tier * 1000 - Math.min(300, at * 3) - Math.min(300, gaps * 3) - Math.min(300, len);

/** Exact > prefix > word start > contiguous > in-order letters (gaps penalised). `q` and `t` are normalized, `q` not empty. */
export function match(q: string, t: string): Match | null {
  if (t === q) return { tier: TIER.exact, score: scored(TIER.exact, 0, 0, t.length), positions: run(0, q.length) };
  if (t.startsWith(q)) return { tier: TIER.prefix, score: scored(TIER.prefix, 0, 0, t.length), positions: run(0, q.length) };
  for (let w = t.indexOf(q, 1); w !== -1; w = t.indexOf(q, w + 1))
    if (isBoundary(t, w)) return { tier: TIER.wordStart, score: scored(TIER.wordStart, w, 0, t.length), positions: run(w, q.length) };
  const at = t.indexOf(q);
  if (at !== -1) return { tier: TIER.substring, score: scored(TIER.substring, at, 0, t.length), positions: run(at, q.length) };
  // ponytail: greedy left-to-right letters, not the tightest possible alignment; upgrade = a small DP if names get long
  const positions: number[] = [];
  for (let i = 0, from = 0; i < q.length; i++) {
    const p = t.indexOf(q[i], from);
    if (p === -1) return null;
    positions.push(p);
    from = p + 1;
  }
  const gaps = positions[positions.length - 1] - positions[0] + 1 - q.length;
  return { tier: TIER.subsequence, score: scored(TIER.subsequence, positions[0], gaps, t.length), positions };
}

type Prepared = { name: string; scope: string };
const cache = new WeakMap<object, Prepared>();
const prepared = (item: Searchable): Prepared => {
  let p = cache.get(item);
  if (!p) cache.set(item, (p = { name: normalize(item.name), scope: item.scope ? normalize(item.scope) : "" }));
  return p;
};

export type Row<T> = { item: T; ranges: Range[]; tier: number; score: number };
export type GroupKind = Kind | "recent";
export type Group<T> = { kind: GroupKind; rows: Row<T>[] };

/** The item against the query: its name first, then "name scope" (typing a server's name lists its channels). */
function rowFor<T extends Searchable>(item: T, q: string): Row<T> | null {
  const p = prepared(item);
  const hit = match(q, p.name);
  if (hit) return { item, ranges: toRanges(normalizeMapped(item.name), hit.positions), tier: hit.tier, score: hit.score };
  if (!p.scope) return null;
  const at = `${p.name} ${p.scope}`.indexOf(q);
  if (at === -1) return null;
  const inName = run(at, q.length).filter((i) => i < p.name.length);
  return { item, ranges: inName.length ? toRanges(normalizeMapped(item.name), inName) : [], tier: TIER.scope, score: scored(TIER.scope, at, 0, p.name.length) };
}

const byName = (a: Searchable, b: Searchable) => a.name.localeCompare(b.name, "vi");
const DEFAULT_PER_GROUP = 5;

/**
 * Results grouped by kind in the fixed KIND_ORDER, best first inside a group, empty groups left out, at most `limit`
 * rows. Decision: the order of the groups is fixed EXCEPT that an exact name match (the best result overall) lifts its
 * group to the top, so typing a full name and pressing Enter does what the user means. With no query: `recents` as
 * the "recent" group; with no recents either, the first few of every kind.
 */
export function searchGroups<T extends Searchable>(items: T[], query: string, { recents = [], limit = 50 }: { recents?: T[]; limit?: number } = {}): Group<T>[] {
  const q = normalize(query);
  let groups: Group<T>[];
  if (!q) {
    const plain = (item: T): Row<T> => ({ item, ranges: [], tier: 0, score: 0 });
    groups = recents.length
      ? [{ kind: "recent", rows: recents.map(plain) }]
      : KIND_ORDER.map((kind) => ({ kind, rows: items.filter((i) => i.kind === kind).sort(byName).slice(0, DEFAULT_PER_GROUP).map(plain) }));
  } else {
    const rows = items.map((item) => rowFor(item, q)).filter((r): r is Row<T> => !!r);
    groups = KIND_ORDER.map((kind) => ({ kind, rows: rows.filter((r) => r.item.kind === kind).sort((a, b) => b.score - a.score || byName(a.item, b.item)) }));
    const best = groups.flatMap((g) => g.rows).reduce<Row<T> | null>((m, r) => (!m || r.score > m.score ? r : m), null);
    if (best?.tier === TIER.exact) groups.sort((a, b) => Number(b.kind === best.item.kind) - Number(a.kind === best.item.kind));
  }
  const out: Group<T>[] = [];
  let room = limit;
  for (const g of groups) {
    const rows = g.rows.slice(0, room);
    if (rows.length) out.push({ ...g, rows });
    room -= rows.length;
  }
  return out;
}

export const flatten = <T>(groups: Group<T>[]): Row<T>[] => groups.flatMap((g) => g.rows);
