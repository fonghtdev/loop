/** How much the zoom toggle enlarges the fitted picture. ponytail: two fixed steps (fit / 1.8x), pan is the browser's scroll; free pan and pinch are the upgrade. */
export const ZOOM = 1.8;

export type Zoom = "fit" | "zoom";
export type ViewerState = { phase: "closed" } | { phase: "opening" } | { phase: "open"; zoom: Zoom } | { phase: "closing" };
export type ViewerEvent = "open" | "opened" | "toggleZoom" | "close" | "closed";

export const CLOSED: ViewerState = { phase: "closed" };

/**
 * closed -> opening (the picture flies out of its thumbnail) -> open(fit | zoom) -> closing (it flies back) -> closed.
 * Anything that does not fit the phase (a zoom click while opening, a second close) is ignored, so a double Esc or a
 * click during an animation cannot leave the viewer half-open; closing may be cut short by a new open.
 */
export function viewerStep(state: ViewerState, event: ViewerEvent): ViewerState {
  switch (event) {
    case "open":
      return state.phase === "closed" || state.phase === "closing" ? { phase: "opening" } : state;
    case "opened":
      return state.phase === "opening" ? { phase: "open", zoom: "fit" } : state;
    case "toggleZoom":
      return state.phase === "open" ? { phase: "open", zoom: state.zoom === "fit" ? "zoom" : "fit" } : state;
    case "close":
      return state.phase === "opening" || state.phase === "open" ? { phase: "closing" } : state;
    case "closed":
      return state.phase === "closing" ? CLOSED : state;
  }
}

export type Rect = { left: number; top: number; width: number; height: number };

/**
 * The transform that makes the picture at `to` look like it is at `from` (FLIP, first frame of the opening or last of
 * the closing): centres aligned, one uniform scale so the picture is never stretched. Nothing else is compensated.
 */
export function flipDelta(from: Rect, to: Rect): { x: number; y: number; scale: number } {
  const scale = to.width > 0 && to.height > 0 ? Math.min(from.width / to.width, from.height / to.height) : 1;
  return {
    x: from.left + from.width / 2 - (to.left + to.width / 2),
    y: from.top + from.height / 2 - (to.top + to.height / 2),
    scale: scale > 0 ? scale : 1,
  };
}
