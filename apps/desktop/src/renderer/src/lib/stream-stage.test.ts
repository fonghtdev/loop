import { describe, expect, it } from "vitest";
import { stageModel, type StreamRef } from "./stream-stage";

const me: StreamRef = { userId: "me", isLocal: true };
const ann: StreamRef = { userId: "ann", isLocal: false };
const bob: StreamRef = { userId: "bob", isLocal: false };
const ids = (m: ReturnType<typeof stageModel>) => [m.stage?.userId ?? null, m.strip.map((s) => s.userId)];

describe("stageModel", () => {
  it("no streams: no stage, the plain grid", () => {
    expect(stageModel([], [], null)).toEqual({ stage: null, strip: [] });
  });

  it("our own share goes on stage at once, watched", () => {
    expect(stageModel([me], [], null).stage).toEqual({ ...me, watched: true });
  });

  it("someone's stream we have not watched is on stage as the invitation (not watched)", () => {
    expect(stageModel([ann], [], null).stage).toEqual({ ...ann, watched: false });
  });

  it("a watched stream beats an unwatched one for the stage; the other waits in the strip", () => {
    expect(ids(stageModel([ann, bob], ["bob"], null))).toEqual(["bob", ["ann"]]);
  });

  it("a second sharer joining does not take the stage away; it lands in the strip", () => {
    const before = stageModel([ann], ["ann"], null);
    const after = stageModel([ann, bob], ["ann"], null);
    expect(before.stage?.userId).toBe("ann");
    expect(ids(after)).toEqual(["ann", ["bob"]]);
  });

  it("clicking a strip stream puts it on stage and the old one goes to the strip, watched or not", () => {
    expect(ids(stageModel([ann, bob], ["ann"], "bob"))).toEqual(["bob", ["ann"]]);
    expect(stageModel([ann, bob], ["ann"], "bob").stage?.watched).toBe(false);
    expect(stageModel([ann, bob], ["ann"], "bob").strip[0].watched).toBe(true);
  });

  it("when the stage's sharer stops, the next stream we can see takes over", () => {
    expect(ids(stageModel([me, bob], [], "ann"))).toEqual(["me", ["bob"]]);
  });

  it("when the last stream ends the stage is gone", () => {
    expect(stageModel([], ["ann"], "ann").stage).toBeNull();
  });

  it("after we stop watching, that stream stays on stage as the invitation instead of vanishing", () => {
    const m = stageModel([ann, bob], [], "ann");
    expect(ids(m)).toEqual(["ann", ["bob"]]);
    expect(m.stage?.watched).toBe(false);
  });

  it("our own share and a watched stream: one on stage, the other in the strip, never both", () => {
    expect(ids(stageModel([me, ann], ["ann"], null))).toEqual(["me", ["ann"]]);
    expect(ids(stageModel([me, ann], ["ann"], "ann"))).toEqual(["ann", ["me"]]);
  });
});
