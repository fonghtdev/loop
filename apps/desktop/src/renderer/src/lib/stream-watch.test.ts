import { describe, expect, it } from "vitest";
import { clampVolume, effectiveVolume, pruneWatching, subscriptionChanges, viewersOf } from "./stream-watch";

describe("clampVolume", () => {
  it.each([[-1, 0], [0.4, 0.4], [7, 1], [Number.NaN, 1]])("%s -> %s", (v, want) => expect(clampVolume(v)).toBe(want));
});

describe("effectiveVolume", () => {
  it("deafen or mute wins over the slider; otherwise the clamped slider", () => {
    expect(effectiveVolume(true, false, 0.8)).toBe(0);
    expect(effectiveVolume(false, true, 0.8)).toBe(0);
    expect(effectiveVolume(false, false, 0.8)).toBe(0.8);
    expect(effectiveVolume(false, false, 3)).toBe(1);
    expect(effectiveVolume(false, false, 1.5, 2)).toBe(1.5); // a person's microphone may go to 200%
    expect(effectiveVolume(false, false, 3, 2)).toBe(2);
    expect(effectiveVolume(true, false, 1.5, 2)).toBe(0);
  });
});

describe("subscriptionChanges", () => {
  const pubs = [
    { userId: "a", source: "screen_share", subscribed: true },
    { userId: "a", source: "screen_share_audio", subscribed: true },
    { userId: "a", source: "microphone", subscribed: true },
    { userId: "b", source: "screen_share", subscribed: false },
    { userId: "b", source: "camera", subscribed: true },
    { userId: "c", source: "screen_share", subscribed: false },
  ];
  it("watching b: unsubscribes a's screen, subscribes b's, touches only what differs and never mic or camera", () => {
    expect(subscriptionChanges(["b"], pubs).map((p) => `${p.userId}:${p.source}:${p.subscribe}`)).toEqual(["a:screen_share:false", "a:screen_share_audio:false", "b:screen_share:true"]);
  });
  it("nothing to change when already in line", () => {
    expect(subscriptionChanges(["a"], pubs.filter((p) => p.userId === "a"))).toEqual([]);
  });
});

describe("pruneWatching", () => {
  it("keeps only current sharers, and returns the same array when nothing changed", () => {
    const w = ["a", "b"];
    expect(pruneWatching(w, new Set(["a", "b", "c"]))).toBe(w);
    expect(pruneWatching(w, new Set(["b"]))).toEqual(["b"]);
  });
});

describe("viewersOf", () => {
  const room = [{ userId: "s", watching: ["s"] }, { userId: "a", watching: ["s", "x"] }, { userId: "b", watching: ["x"] }, { userId: "c" }];
  it("lists those who announce watching the streamer, not the streamer, not the rest", () => {
    expect(viewersOf(room, "s").map((p) => p.userId)).toEqual(["a"]);
    expect(viewersOf(room, "x").map((p) => p.userId)).toEqual(["a", "b"]);
  });
});
