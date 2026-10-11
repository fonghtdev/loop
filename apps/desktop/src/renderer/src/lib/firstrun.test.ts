import { describe, expect, it, vi } from "vitest";
import { allDone, completionWatcher, createFirstRun, doneCount, isFirstRun, parseSaved, progress, shouldShow, EMPTY_SAVED, type Done } from "./firstrun";

const none = { servers: 0, friends: 0, dms: 0 };
const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe("progress (derived from real data + saved events)", () => {
  it("a new account has nothing done", () => {
    expect(progress(none, EMPTY_SAVED)).toEqual({ server: false, friend: false, message: false, voice: false });
  });
  it("a server marks the server step only", () => {
    expect(progress({ ...none, servers: 1 }, EMPTY_SAVED)).toEqual({ server: true, friend: false, message: false, voice: false });
  });
  it("a friend or a DM marks the friend step", () => {
    expect(progress({ ...none, friends: 1 }, EMPTY_SAVED).friend).toBe(true);
    expect(progress({ ...none, dms: 2 }, EMPTY_SAVED).friend).toBe(true);
  });
  it("message and voice come only from saved events, never from the counts", () => {
    const d = progress({ servers: 3, friends: 3, dms: 3 }, EMPTY_SAVED);
    expect([d.message, d.voice]).toEqual([false, false]);
    expect(progress(none, { events: ["message"], dismissed: false }).message).toBe(true);
    expect(progress(none, { events: ["voice"], dismissed: false }).voice).toBe(true);
  });
});

describe("shouldShow", () => {
  const open = progress(none, EMPTY_SAVED);
  const full: Done = { server: true, friend: true, message: true, voice: true };
  it("shows while a step is open and it is not hidden", () => expect(shouldShow(open, EMPTY_SAVED)).toBe(true));
  it("never shows for a dismissed account", () => expect(shouldShow(open, { events: [], dismissed: true })).toBe(false));
  it("hides itself when everything is done", () => {
    expect(allDone(full)).toBe(true);
    expect(shouldShow(full, EMPTY_SAVED)).toBe(false);
    expect(doneCount({ ...full, voice: false })).toBe(3);
  });
  it("first run = no server, no friend, no DM", () => {
    expect(isFirstRun(none)).toBe(true);
    expect(isFirstRun({ ...none, dms: 1 })).toBe(false);
  });
});

describe("parseSaved", () => {
  it.each([null, "", "{", "null", "7", '"x"', "[]", '{"events":"message"}'])("falls back to empty for %j", (raw) => {
    expect(parseSaved(raw)).toEqual(EMPTY_SAVED);
  });
  it("keeps only known events and a real boolean", () => {
    expect(parseSaved('{"events":["voice","hack","message"],"dismissed":"yes"}')).toEqual({ events: ["message", "voice"], dismissed: false });
    expect(parseSaved('{"events":[],"dismissed":true}').dismissed).toBe(true);
  });
});

describe("createFirstRun (per-account storage)", () => {
  it("records an event once and persists it", () => {
    const mem = memory();
    const run = createFirstRun(() => mem);
    run.start("a");
    expect(run.record("message")).toBe(true);
    expect(run.record("message")).toBe(false);
    run.stop();
    run.start("a");
    expect(run.store.getState().saved.events).toEqual(["message"]);
  });
  it("one account's progress does not leak to another", () => {
    const mem = memory();
    const run = createFirstRun(() => mem);
    run.start("a");
    run.record("voice");
    run.dismiss();
    run.start("b");
    expect(run.store.getState().saved).toEqual(EMPTY_SAVED);
    run.record("message");
    run.start("a");
    expect(run.store.getState().saved).toEqual({ events: ["voice"], dismissed: true });
  });
  it("dismissal persists across a restart (a new instance on the same storage)", () => {
    const mem = memory();
    const first = createFirstRun(() => mem);
    first.start("a");
    first.dismiss();
    const second = createFirstRun(() => mem);
    second.start("a");
    expect(second.store.getState().saved.dismissed).toBe(true);
  });
  it("ignores events while signed out, and survives corrupt or throwing storage", () => {
    const mem = memory();
    const run = createFirstRun(() => mem);
    expect(run.record("voice")).toBe(false);
    mem.data.set("loop.firstRun.a", "{{{");
    run.start("a");
    expect(run.store.getState().saved).toEqual(EMPTY_SAVED);
    const broken = createFirstRun(() => ({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    }));
    broken.start("a");
    expect(broken.record("message")).toBe(true); // kept in memory for this session
    expect(broken.store.getState().saved.events).toEqual(["message"]);
  });
});

describe("completionWatcher", () => {
  const open: Done = { server: true, friend: true, message: true, voice: false };
  const full: Done = { ...open, voice: true };
  it("fires once, on the transition to all done", () => {
    const fn = vi.fn();
    const watch = completionWatcher(fn);
    watch(open);
    expect(fn).not.toHaveBeenCalled();
    watch(full);
    watch(full);
    watch(open);
    watch(full);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("does not fire for an account that was complete from the start", () => {
    const fn = vi.fn();
    const watch = completionWatcher(fn);
    watch(full);
    watch(full);
    expect(fn).not.toHaveBeenCalled();
  });
});
