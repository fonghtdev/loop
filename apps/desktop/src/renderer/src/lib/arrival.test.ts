import { describe, expect, it } from "vitest";
import { shouldAnimateArrival, type ArrivalContext } from "./arrival";

const base: ArrivalContext = { live: true, nearViewport: true, settled: true, reducedMotion: false };

describe("shouldAnimateArrival", () => {
  it("animates a live message that arrives in view, in a settled list", () => {
    expect(shouldAnimateArrival(base)).toBe(true);
  });
  it.each([
    ["a history page or catch-up (not live)", { live: false }],
    ["the user is scrolled up (not near the viewport)", { nearViewport: false }],
    ["the first page is still loading / an older page is loading", { settled: false }],
    ["reduced motion", { reducedMotion: true }],
  ])("does not animate: %s", (_, patch) => {
    expect(shouldAnimateArrival({ ...base, ...patch })).toBe(false);
  });
});
