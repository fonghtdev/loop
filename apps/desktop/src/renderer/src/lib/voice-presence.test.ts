import { describe, expect, it } from "vitest";
import { createVoicePresence, participantsFor } from "./voice-presence";

const seat = (userId: string) => ({ userId, username: userId.toUpperCase() });

describe("voice presence", () => {
  it("a push replaces the list and dedupes by user", () => {
    const p = createVoicePresence();
    p.update("v1", [seat("a"), seat("b"), seat("a")]);
    expect(p.store.getState().lists.v1.map((s) => s.userId)).toEqual(["a", "b"]);
    p.update("v1", [seat("b")]);
    expect(p.store.getState().lists.v1.map((s) => s.userId)).toEqual(["b"]);
  });

  it("a REST catch-up fills an empty list", () => {
    const p = createVoicePresence();
    p.applyFetched("v1", p.begin("v1"), [seat("a")]);
    expect(p.store.getState().lists.v1).toEqual([seat("a")]);
  });

  it("a REST answer older than a push that arrived meanwhile is dropped", () => {
    const p = createVoicePresence();
    const begun = p.begin("v1");
    p.update("v1", [seat("a"), seat("b")]); // arrives while the request is in flight
    p.applyFetched("v1", begun, []); // the stale answer
    expect(p.store.getState().lists.v1.map((s) => s.userId)).toEqual(["a", "b"]);
    p.applyFetched("v1", p.begin("v1"), [seat("c")]); // a fresh request after the push applies
    expect(p.store.getState().lists.v1.map((s) => s.userId)).toEqual(["c"]);
  });

  it("clear forgets everything (guild change / sign-out)", () => {
    const p = createVoicePresence();
    p.update("v1", [seat("a")]);
    p.clear();
    expect(p.store.getState().lists).toEqual({});
    p.applyFetched("v1", 0, [seat("z")]);
    expect(p.store.getState().lists.v1).toHaveLength(1);
  });
});

describe("participantsFor", () => {
  const lists = { v1: [seat("a")], v2: [seat("b")] };
  const live = { channelId: "v1", participants: [{ ...seat("me"), isLocal: true }, seat("a")] };
  it("the live room wins for the channel we are connected to", () => {
    expect(participantsFor("v1", lists, live).map((p) => p.userId)).toEqual(["me", "a"]);
  });
  it("other channels use the pushed / fetched list; unknown channels are empty", () => {
    expect(participantsFor("v2", lists, live).map((p) => p.userId)).toEqual(["b"]);
    expect(participantsFor("v3", lists, live)).toEqual([]);
    expect(participantsFor("v1", lists, null).map((p) => p.userId)).toEqual(["a"]);
  });
});
