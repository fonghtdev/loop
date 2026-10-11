/** The sliding indicator is ONE element, BASE px wide and anchored at its left edge; the selected tab is shown by translating and stretching it. */
export const INDICATOR_BASE = 100;

export type Spot = { x: number; scaleX: number };

/** Where the indicator goes for a tab that starts at `left` and is `width` wide (both from offsetLeft / offsetWidth). */
export const indicatorSpot = (left: number, width: number): Spot => ({ x: Math.round(left * 100) / 100, scaleX: Math.round((Math.max(0, width) / INDICATOR_BASE) * 1000) / 1000 });

/** The next roving-tabindex step: arrows wrap, Home / End jump, anything else is not ours (-1). */
export function nextTab(count: number, current: number, key: string): number {
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return -1;
}
