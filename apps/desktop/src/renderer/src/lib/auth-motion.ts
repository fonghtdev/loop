import { move, reducedNow, staggerStep, timeline } from "./motion";

/**
 * The entrance of the auth screen as data: when each part starts and how long it runs (ms). One choreography, all of it
 * inside BUDGET.sequenceMax; under reduced motion there is none (null) and the screen simply is its end state.
 */
const ITEM = { at: 140, duration: 300, maxStep: 35 };
const ORBIT = { at: 0, duration: 600, step: 120, count: 3 };
export const ENTRANCE = { card: { at: 0, duration: 420 }, logo: { at: 60, duration: 560 }, orbit: ORBIT, item: ITEM } as const;

export type EntrancePlan = { itemStep: number; end: number };

export function entrancePlan(itemCount: number, reduced: boolean): EntrancePlan | null {
  if (reduced) return null;
  // the last item must still end inside the ceiling, counted from where the items start
  const itemStep = staggerStep(itemCount, ITEM.maxStep, ITEM.at + ITEM.duration);
  const itemsEnd = ITEM.at + Math.max(0, itemCount - 1) * itemStep + ITEM.duration;
  const orbitsEnd = ORBIT.at + (ORBIT.count - 1) * ORBIT.step + ORBIT.duration;
  const end = Math.max(ENTRANCE.card.at + ENTRANCE.card.duration, ENTRANCE.logo.at + ENTRANCE.logo.duration, orbitsEnd, itemsEnd);
  return { itemStep, end };
}

/**
 * Plays it on the wrappers inside `root`: `[data-enter-card]`, `[data-enter]` (in DOM order) and `[data-orbit]`.
 * Only wrappers move, never an input, and nothing here takes focus or delays it. Returns the cleanup.
 */
export function playAuthEntrance(root: HTMLElement): () => void {
  const items = [...root.querySelectorAll<HTMLElement>("[data-enter]")];
  const card = root.querySelector<HTMLElement>("[data-enter-card]");
  const orbits = [...root.querySelectorAll<SVGElement>("[data-orbit]")];
  const plan = entrancePlan(items.length, reducedNow());
  if (!plan) return () => undefined;
  const hidden = [...items, ...(card ? [card] : [])];
  hidden.forEach((el) => (el.style.opacity = "0")); // before the first paint, so nothing flashes
  const tl = timeline({ kind: "entrance", allow: ["strokeDashoffset"] });
  if (card) tl.add(card, { opacity: [0, 1], y: [16, 0], duration: ENTRANCE.card.duration }, ENTRANCE.card.at);
  tl.add(orbits, { strokeDashoffset: [1, 0], duration: ORBIT.duration, delay: (_: unknown, i: number) => i * ORBIT.step }, ORBIT.at);
  tl.add(items, { opacity: [0, 1], y: [10, 0], duration: ITEM.duration, delay: (_: unknown, i: number) => i * plan.itemStep }, ITEM.at);
  void tl.then(() => hidden.forEach((el) => el.style.removeProperty("opacity")));
  return () => {
    tl.revert();
    hidden.forEach((el) => el.style.removeProperty("opacity"));
  };
}

/** The logomark drawing itself: its path (pathLength 1) goes from undrawn to drawn. */
export function drawLogo(path: SVGPathElement, delay = 0) {
  if (reducedNow()) return;
  path.style.strokeDashoffset = "1";
  return move(path, { strokeDashoffset: [1, 0], duration: ENTRANCE.logo.duration, delay, ease: "inOutQuad" }, { kind: "entrance", allow: ["strokeDashoffset"] });
}
