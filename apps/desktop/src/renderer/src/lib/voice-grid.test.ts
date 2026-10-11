import { describe, expect, it } from "vitest";
import { reconcileTiles, tileLayout, TILE_GAP, type Tile } from "./voice-grid";

const person = (id: string) => ({ userId: id, username: id });
const tile = (id: string, state: Tile["state"] = "stay"): Tile => ({ p: person(id), state });
const ids = (tiles: Tile[]) => tiles.map((t) => `${t.p.userId}:${t.state}`);

describe("tileLayout", () => {
  it("one person gets a single, capped tile", () => {
    const l = tileLayout(1, 888, 480);
    expect(l.cols).toBe(1);
    expect(l.width).toBeLessThanOrEqual(460);
  });

  it("every count 1..25 fits the box in both window sizes (no horizontal overflow, rows fit when not scrolling)", () => {
    for (const [w, h] of [[888, 480], [968, 640]] as const)
      for (let n = 1; n <= 25; n++) {
        const l = tileLayout(n, w, h);
        expect(l.cols * l.width + (l.cols - 1) * TILE_GAP, `${n} in ${w}x${h}`).toBeLessThanOrEqual(w);
        expect(l.cols).toBeLessThanOrEqual(n);
        expect(l.height).toBe(Math.round(l.width / 1.6));
      }
  });

  it("columns grow with the crowd until the height is the limit", () => {
    const cols = [1, 2, 4, 9, 16, 25].map((n) => tileLayout(n, 888, 480).cols);
    expect(cols).toEqual([...cols].sort((a, b) => a - b));
    expect(cols[0]).toBe(1);
  });

  it("a wide, short box uses more columns than a narrow, tall one", () => {
    expect(tileLayout(6, 1200, 300).cols).toBeGreaterThan(tileLayout(6, 300, 1200).cols);
  });

  it("a crowd that cannot fit even tiny tiles scrolls vertically at the minimum width instead of shrinking", () => {
    const l = tileLayout(25, 520, 200);
    expect(l.width).toBeGreaterThanOrEqual(132);
    expect(l.cols * l.width + (l.cols - 1) * TILE_GAP).toBeLessThanOrEqual(520);
  });

  it("copes with a zero-size box and zero people", () => {
    expect(tileLayout(0, 0, 0).cols).toBe(1);
  });
});

describe("reconcileTiles", () => {
  it("the first fill of an empty room does not animate", () => {
    expect(ids(reconcileTiles([], [person("a"), person("b")]))).toEqual(["a:stay", "b:stay"]);
  });

  it("a newcomer enters, the others stay", () => {
    expect(ids(reconcileTiles([tile("a")], [person("a"), person("b")]))).toEqual(["a:stay", "b:enter"]);
  });

  it("someone who left stays as a leaving ghost in their slot, then is gone once dropped", () => {
    const left = reconcileTiles([tile("a"), tile("b"), tile("c")], [person("a"), person("c")]);
    expect(ids(left)).toEqual(["a:stay", "b:leave", "c:stay"]);
    expect(ids(reconcileTiles(left, [person("a"), person("c")]))).toEqual(["a:stay", "b:leave", "c:stay"]);
    expect(ids(left.filter((t) => t.state !== "leave"))).toEqual(["a:stay", "c:stay"]);
  });

  it("an entering tile becomes a normal one on the next pass", () => {
    const first = reconcileTiles([tile("a")], [person("a"), person("b")]);
    expect(ids(reconcileTiles(first, [person("a"), person("b")]))).toEqual(["a:stay", "b:stay"]);
  });

  it("a whole room swapping (more than 8 changes) is not animated, in either direction", () => {
    const crowd = Array.from({ length: 12 }, (_, i) => `u${i}`);
    expect(reconcileTiles([tile("x")], crowd.map(person)).every((t) => t.state !== "enter")).toBe(true);
    const gone = reconcileTiles(crowd.map((i) => tile(i)), [person("x")]);
    expect(ids(gone)).toEqual(["x:enter"]); // the 12 leavers vanish without ghosts
  });
});
