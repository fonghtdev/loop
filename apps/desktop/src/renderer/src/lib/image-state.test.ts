import { describe, expect, it } from "vitest";
import { imageStep, initialImage, type ImgEvent, type ImgState } from "./image-state";

const run = (events: ImgEvent[], from: ImgState = initialImage("old")) => events.reduce(imageStep, from);

describe("inline image URL refresh (once)", () => {
  it("a good load just settles", () => {
    expect(run([{ type: "loaded" }])).toMatchObject({ phase: "ok", src: "old" });
  });
  it("the first error asks for a fresh URL; the fresh URL is tried", () => {
    expect(run([{ type: "error" }])).toMatchObject({ phase: "refreshing", refreshed: true });
    expect(run([{ type: "error" }, { type: "fresh", url: "new" }])).toMatchObject({ phase: "loading", src: "new" });
    expect(run([{ type: "error" }, { type: "fresh", url: "new" }, { type: "loaded" }])).toMatchObject({ phase: "ok", src: "new" });
  });
  it("an error after the refresh stops at failed: no second refresh, no loop", () => {
    const failed = run([{ type: "error" }, { type: "fresh", url: "new" }, { type: "error" }]);
    expect(failed.phase).toBe("failed");
    expect(imageStep(failed, { type: "error" })).toBe(failed);
  });
  it("counts the refreshes a stream of errors can cause: exactly one", () => {
    let state = initialImage("old");
    let refreshes = 0;
    for (let i = 0; i < 20; i++) {
      const next = imageStep(state, { type: "error" });
      if (next.phase === "refreshing") {
        refreshes++;
        state = imageStep(next, { type: "fresh", url: `u${i}` });
      } else state = next;
    }
    expect(refreshes).toBe(1);
    expect(state.phase).toBe("failed");
  });
  it("a refresh that itself fails is final", () => {
    expect(run([{ type: "error" }, { type: "freshFailed" }]).phase).toBe("failed");
  });
  it("the Retry button refreshes again, once, and then fails for good if the image still will not load", () => {
    const failed = run([{ type: "error" }, { type: "freshFailed" }]);
    const retrying = imageStep(failed, { type: "retry" });
    expect(retrying.phase).toBe("refreshing");
    expect(run([{ type: "fresh", url: "n2" }, { type: "error" }], retrying).phase).toBe("failed");
  });
  it("late events in the wrong phase change nothing", () => {
    const s = initialImage("old");
    expect(imageStep(s, { type: "fresh", url: "x" })).toBe(s);
    expect(imageStep(s, { type: "retry" })).toBe(s);
  });
});
