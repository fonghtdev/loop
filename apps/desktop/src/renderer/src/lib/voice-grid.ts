import type { Participant } from "./voice-presence";

export const TILE_GAP = 12;
const RATIO = 1.6; // tiles are 16:10
const MIN_W = 132; // narrower than this the picture is not worth it: scroll instead of shrinking
const MAX_W = 460;

export type TileLayout = { cols: number; width: number; height: number };

/**
 * How many columns and which tile width fit `count` tiles into a `w` x `h` box: the widest tile that still shows every
 * row without scrolling. If even that is under MIN_W (a crowded room in a small window) it falls back to as many
 * MIN_W columns as the width holds and the room scrolls vertically; it never needs horizontal scrolling.
 */
export function tileLayout(count: number, w: number, h: number): TileLayout {
  const n = Math.max(1, count);
  let best = { cols: 1, width: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const byWidth = (w - TILE_GAP * (cols - 1)) / cols;
    const byHeight = ((h - TILE_GAP * (rows - 1)) / rows) * RATIO;
    const width = Math.min(byWidth, byHeight, MAX_W);
    if (width > best.width + 0.5) best = { cols, width };
  }
  if (best.width < MIN_W) {
    const cols = Math.min(n, Math.max(1, Math.floor((w + TILE_GAP) / (MIN_W + TILE_GAP))));
    best = { cols, width: Math.min(MAX_W, (w - TILE_GAP * (cols - 1)) / cols) };
  }
  const width = Math.max(0, Math.floor(best.width));
  return { cols: best.cols, width, height: Math.round(width / RATIO) };
}

export type Tile = { p: Participant; state: "enter" | "stay" | "leave" };
const MOTION_MAX = 8; // a bigger change (the whole room swapping) is not worth animating

/**
 * Next rendered tile list from the previous one and the people now present. New people enter (never for the first
 * fill of an empty room, and not more than MOTION_MAX at once), people who left stay as "leave" until their exit
 * animation is over (the caller then drops them), everybody else keeps their place.
 */
export function reconcileTiles(prev: Tile[], people: Participant[]): Tile[] {
  const before = new Map(prev.map((t) => [t.p.userId, t]));
  const now = new Set(people.map((p) => p.userId));
  const entering = people.filter((p) => !before.has(p.userId) || before.get(p.userId)!.state === "leave").length;
  const animateIn = prev.some((t) => t.state !== "leave") && entering <= MOTION_MAX;
  const leavers = prev.filter((t) => !now.has(t.p.userId) && t.state !== "leave");
  const keepLeavers = leavers.length <= MOTION_MAX;
  const next: Tile[] = people.map((p) => {
    const old = before.get(p.userId);
    return { p, state: old && old.state !== "leave" ? (old.state === "enter" ? "stay" : old.state) : animateIn ? "enter" : "stay" };
  });
  // a leaver keeps its slot (by previous order) until it is dropped
  const ghosts = prev.filter((t) => !now.has(t.p.userId) && (t.state === "leave" || keepLeavers)).map((t) => ({ p: t.p, state: "leave" as const }));
  for (const g of ghosts) {
    const at = prev.findIndex((t) => t.p.userId === g.p.userId);
    next.splice(Math.min(at, next.length), 0, g);
  }
  return next;
}
