import { describe, expect, it } from "vitest";
import { allReady, canSend, step, type AttEvent, type AttState } from "./attachment-machine";

const run = (events: AttEvent[], from: AttState = { phase: "picked" }) => events.reduce(step, from);

describe("attachment state machine", () => {
  it("picked -> validating -> uploading(progress) -> completing -> ready", () => {
    expect(run([{ type: "validate" }])).toEqual({ phase: "validating" });
    expect(run([{ type: "validate" }, { type: "valid" }])).toEqual({ phase: "uploading", progress: 0 });
    expect(run([{ type: "validate" }, { type: "valid" }, { type: "progress", value: 0.4 }])).toEqual({ phase: "uploading", progress: 0.4 });
    expect(run([{ type: "validate" }, { type: "valid" }, { type: "uploaded" }])).toEqual({ phase: "completing" });
    expect(run([{ type: "validate" }, { type: "valid" }, { type: "uploaded" }, { type: "done", id: "a1" }])).toEqual({ phase: "ready", id: "a1" });
  });

  it("progress is clamped to 0..1", () => {
    const up: AttState = { phase: "uploading", progress: 0 };
    expect(step(up, { type: "progress", value: 7 })).toEqual({ phase: "uploading", progress: 1 });
    expect(step(up, { type: "progress", value: -1 })).toEqual({ phase: "uploading", progress: 0 });
  });

  it("fails from any in-flight phase, with the reason", () => {
    for (const phase of [{ phase: "validating" }, { phase: "uploading", progress: 0.5 }, { phase: "completing" }] as AttState[])
      expect(step(phase, { type: "fail", reason: "network" })).toEqual({ phase: "failed", reason: "network" });
  });

  it("retry restarts a failed attachment and nothing else", () => {
    expect(step({ phase: "failed", reason: "storage" }, { type: "retry" })).toEqual({ phase: "picked" });
    const up: AttState = { phase: "uploading", progress: 0.2 };
    expect(step(up, { type: "retry" })).toBe(up);
    const ready: AttState = { phase: "ready", id: "x" };
    expect(step(ready, { type: "retry" })).toBe(ready);
  });

  it("remove works from every phase, mid-upload too, and is final: late events change nothing", () => {
    for (const s of [{ phase: "picked" }, { phase: "uploading", progress: 0.3 }, { phase: "completing" }, { phase: "ready", id: "x" }, { phase: "failed", reason: "unknown" }] as AttState[])
      expect(step(s, { type: "remove" })).toEqual({ phase: "removed" });
    const removed = run([{ type: "validate" }, { type: "valid" }, { type: "remove" }]);
    for (const late of [{ type: "progress", value: 1 }, { type: "uploaded" }, { type: "done", id: "z" }, { type: "fail", reason: "network" }, { type: "retry" }] as AttEvent[])
      expect(step(removed, late)).toBe(removed);
  });

  it("ignores events that do not fit the phase (a late 'done' cannot skip the checks)", () => {
    const up: AttState = { phase: "uploading", progress: 0.5 };
    expect(step(up, { type: "done", id: "x" })).toBe(up);
    const ready: AttState = { phase: "ready", id: "x" };
    expect(step(ready, { type: "fail", reason: "network" })).toBe(ready);
  });
});

describe("Send is allowed only when every file is ready", () => {
  const ready: AttState = { phase: "ready", id: "a" };
  const base = { disabled: false, over: false, textLength: 0 };
  it.each<[string, AttState]>([
    ["picked", { phase: "picked" }],
    ["validating", { phase: "validating" }],
    ["uploading", { phase: "uploading", progress: 0.5 }],
    ["completing", { phase: "completing" }],
    ["failed", { phase: "failed", reason: "network" }],
  ])("not while one file is %s", (_name, pending) => {
    expect(allReady([ready, pending])).toBe(false);
    expect(canSend({ ...base, textLength: 5, files: [ready, pending] })).toBe(false);
  });
  it("sends text alone, files alone, or both; never nothing; never when closed or over the limit", () => {
    expect(canSend({ ...base, textLength: 3, files: [] })).toBe(true);
    expect(canSend({ ...base, files: [ready] })).toBe(true);
    expect(canSend({ ...base, textLength: 3, files: [ready] })).toBe(true);
    expect(canSend({ ...base, files: [] })).toBe(false);
    expect(canSend({ ...base, textLength: 3, disabled: true, files: [] })).toBe(false);
    expect(canSend({ ...base, textLength: 3, over: true, files: [] })).toBe(false);
  });
});
