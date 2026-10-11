import { describe, expect, it } from "vitest";
import { CLOSED, flipDelta, viewerStep, type ViewerEvent, type ViewerState } from "./viewer-machine";

const run = (events: ViewerEvent[], from: ViewerState = CLOSED) => events.reduce(viewerStep, from);

describe("viewer state machine", () => {
  it("walks closed -> opening -> open(fit) -> closing -> closed", () => {
    expect(run(["open"])).toEqual({ phase: "opening" });
    expect(run(["open", "opened"])).toEqual({ phase: "open", zoom: "fit" });
    expect(run(["open", "opened", "close"])).toEqual({ phase: "closing" });
    expect(run(["open", "opened", "close", "closed"])).toEqual(CLOSED);
  });

  it("zoom toggles between fit and zoom, only while open", () => {
    expect(run(["open", "opened", "toggleZoom"])).toEqual({ phase: "open", zoom: "zoom" });
    expect(run(["open", "opened", "toggleZoom", "toggleZoom"])).toEqual({ phase: "open", zoom: "fit" });
    expect(run(["open", "toggleZoom"])).toEqual({ phase: "opening" });
    expect(run(["open", "opened", "close", "toggleZoom"])).toEqual({ phase: "closing" });
    expect(run(["toggleZoom"])).toEqual(CLOSED);
  });

  it("closing from a zoomed picture is allowed and forgets the zoom", () => {
    expect(run(["open", "opened", "toggleZoom", "close", "closed", "open", "opened"])).toEqual({ phase: "open", zoom: "fit" });
  });

  it("Esc while it is still opening closes it; a second close does nothing", () => {
    expect(run(["open", "close"])).toEqual({ phase: "closing" });
    expect(run(["open", "close", "close"])).toEqual({ phase: "closing" });
  });

  it("stray events are ignored: opened/closed out of turn, open while open", () => {
    expect(run(["opened"])).toEqual(CLOSED);
    expect(run(["closed"])).toEqual(CLOSED);
    expect(run(["open", "opened", "open"])).toEqual({ phase: "open", zoom: "fit" });
    expect(run(["open", "closed"])).toEqual({ phase: "opening" });
  });

  it("a new open cuts a closing short", () => {
    expect(run(["open", "opened", "close", "open"])).toEqual({ phase: "opening" });
  });
});

describe("flipDelta", () => {
  it("a picture already where it was needs no move", () => {
    const r = { left: 100, top: 50, width: 400, height: 300 };
    expect(flipDelta(r, r)).toEqual({ x: 0, y: 0, scale: 1 });
  });
  it("aligns the centres and scales uniformly by the smaller ratio", () => {
    const thumb = { left: 0, top: 0, width: 160, height: 120 };
    const full = { left: 300, top: 100, width: 800, height: 400 };
    const d = flipDelta(thumb, full);
    expect(d.scale).toBeCloseTo(0.2); // min(160/800, 120/400)
    expect(d.x).toBe(80 - 700);
    expect(d.y).toBe(60 - 300);
  });
  it("a zero-sized target does not divide by zero", () => {
    expect(flipDelta({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 0, height: 0 }).scale).toBe(1);
  });
});
