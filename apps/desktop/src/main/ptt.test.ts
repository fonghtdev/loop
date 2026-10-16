import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPtt, parseBinding, PTT_RELEASE_DELAY_MS, type KeyEvent, type KeyHook } from "./ptt";

const ev = (type: "down" | "up", key: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({ type, key, ctrl: false, alt: false, shift: false, meta: false, ...mods });

function setup({ hook = true, permitted = true, startFails = false, platform = "win32" } = {}) {
  let onKey: ((e: KeyEvent) => void) | undefined;
  const fake = { starts: 0, stops: 0 };
  const keyHook: KeyHook = {
    start: (cb) => {
      if (startFails) throw new Error("hook failed");
      fake.starts++;
      onKey = cb;
    },
    stop: () => {
      fake.stops++;
      onKey = undefined;
    },
  };
  const sent: boolean[] = [];
  const loadHook = vi.fn(() => (hook ? keyHook : null));
  const permitCalls: boolean[] = [];
  const ptt = createPtt({ loadHook, send: (h) => sent.push(h), permitted: (prompt) => (permitCalls.push(prompt), permitted), platform });
  return { ptt, sent, fake, loadHook, permitCalls, press: (e: KeyEvent) => onKey?.(e), running: () => !!onKey };
}
const on = (pttKey = "F13") => ({ pttMode: true, pttKey });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("parseBinding", () => {
  it("reads the key and the exact modifiers; CommandOrControl is Cmd on macOS and Ctrl elsewhere", () => {
    expect(parseBinding("F13", "win32")).toEqual({ key: "F13", ctrl: false, alt: false, shift: false, meta: false });
    expect(parseBinding("Control+Shift+Space", "win32")).toMatchObject({ key: "Space", ctrl: true, shift: true, meta: false });
    expect(parseBinding("CommandOrControl+K", "darwin")).toMatchObject({ ctrl: false, meta: true });
    expect(parseBinding("CommandOrControl+K", "win32")).toMatchObject({ ctrl: true, meta: false });
    expect(parseBinding("Super+Alt+`", "win32")).toMatchObject({ key: "`", meta: true, alt: true });
  });
});

describe("push-to-talk hook lifecycle", () => {
  it("runs only with push-to-talk on, a key bound AND the renderer in a room; stops when it leaves", () => {
    const s = setup();
    s.ptt.apply(on());
    expect(s.running()).toBe(false); // not in a room
    s.ptt.setRoom(true);
    expect(s.running()).toBe(true);
    s.ptt.setRoom(false);
    expect(s.running()).toBe(false);
    expect(s.fake.stops).toBe(1);
  });

  it("stays off without a key, or in voice-activity mode", () => {
    const s = setup();
    s.ptt.setRoom(true);
    s.ptt.apply({ pttMode: true, pttKey: "" });
    s.ptt.apply({ pttMode: false, pttKey: "F13" });
    expect(s.fake.starts).toBe(0);
    s.ptt.apply(on());
    expect(s.fake.starts).toBe(1);
    s.ptt.apply({ pttMode: false, pttKey: "F13" });
    expect(s.running()).toBe(false);
  });

  it("does not start twice when asked twice", () => {
    const s = setup();
    s.ptt.apply(on());
    s.ptt.setRoom(true);
    s.ptt.setRoom(true);
    expect(s.fake.starts).toBe(1);
  });

  it("leaving the room while the key is held releases at once (no stuck-open mic)", () => {
    const s = setup();
    s.ptt.apply(on());
    s.ptt.setRoom(true);
    s.press(ev("down", "F13"));
    s.ptt.setRoom(false);
    expect(s.sent).toEqual([true, false]);
  });

  it("changing the bound key while held releases it", () => {
    const s = setup();
    s.ptt.apply(on("F13"));
    s.ptt.setRoom(true);
    s.press(ev("down", "F13"));
    s.ptt.apply(on("F14"));
    expect(s.sent).toEqual([true, false]);
    s.press(ev("down", "F14"));
    expect(s.sent).toEqual([true, false, true]);
  });
});

describe("push-to-talk key events", () => {
  const live = () => {
    const s = setup();
    s.ptt.apply(on("Space"));
    s.ptt.setRoom(true);
    return s;
  };

  it("forwards only the bound key: nothing else reaches the renderer", () => {
    const s = live();
    for (const key of ["A", "Enter", "F13", "Tab"]) {
      s.press(ev("down", key));
      s.press(ev("up", key));
    }
    vi.advanceTimersByTime(1000);
    expect(s.sent).toEqual([]);
  });

  it("press sends held, release sends released after the delay", () => {
    const s = live();
    s.press(ev("down", "Space"));
    expect(s.sent).toEqual([true]);
    s.press(ev("up", "Space"));
    vi.advanceTimersByTime(PTT_RELEASE_DELAY_MS - 1);
    expect(s.sent).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(s.sent).toEqual([true, false]);
  });

  it("key repeat does not send again", () => {
    const s = live();
    for (let i = 0; i < 5; i++) s.press(ev("down", "Space"));
    expect(s.sent).toEqual([true]);
  });

  it("pressing again inside the release delay keeps it held (no false in between)", () => {
    const s = live();
    s.press(ev("down", "Space"));
    s.press(ev("up", "Space"));
    vi.advanceTimersByTime(PTT_RELEASE_DELAY_MS / 2);
    s.press(ev("down", "Space"));
    vi.advanceTimersByTime(PTT_RELEASE_DELAY_MS * 2);
    expect(s.sent).toEqual([true]);
    s.press(ev("up", "Space"));
    vi.advanceTimersByTime(PTT_RELEASE_DELAY_MS);
    expect(s.sent).toEqual([true, false]);
  });

  it("a key bound with modifiers needs exactly them on the press, but the release needs only the key", () => {
    const s = setup();
    s.ptt.apply(on("Control+Space"));
    s.ptt.setRoom(true);
    s.press(ev("down", "Space"));
    s.press(ev("down", "Space", { ctrl: true, shift: true }));
    expect(s.sent).toEqual([]);
    s.press(ev("down", "Space", { ctrl: true }));
    s.press(ev("up", "Space")); // Ctrl was let go first
    vi.advanceTimersByTime(PTT_RELEASE_DELAY_MS);
    expect(s.sent).toEqual([true, false]);
  });

  it("an up without a press sends nothing", () => {
    const s = live();
    s.press(ev("up", "Space"));
    vi.advanceTimersByTime(1000);
    expect(s.sent).toEqual([]);
  });
});

describe("push-to-talk availability", () => {
  it("a module that cannot load is 'unavailable' and nothing crashes", () => {
    const s = setup({ hook: false });
    s.ptt.apply(on());
    expect(s.ptt.setRoom(true)).toBe("unavailable");
    expect(s.ptt.status()).toBe("unavailable");
  });

  it("a hook that throws on start is 'unavailable' and is not retried", () => {
    const s = setup({ startFails: true });
    s.ptt.apply(on());
    expect(s.ptt.setRoom(true)).toBe("unavailable");
    s.ptt.setRoom(false);
    s.ptt.setRoom(true);
    expect(s.fake.starts).toBe(0);
  });

  it("without the macOS permission it asks once per start, does not run and says 'permission'", () => {
    const s = setup({ permitted: false, platform: "darwin" });
    s.ptt.apply(on());
    expect(s.ptt.setRoom(true)).toBe("permission");
    expect(s.running()).toBe(false);
    expect(s.permitCalls).toContain(true); // the prompt
  });

  it("the module is loaded lazily: not before the status or a room is asked about", () => {
    const s = setup();
    expect(s.loadHook).not.toHaveBeenCalled();
    s.ptt.status();
    expect(s.loadHook).toHaveBeenCalledTimes(1);
    s.ptt.setRoom(true);
    expect(s.loadHook).toHaveBeenCalledTimes(1);
  });

  it("dispose stops the hook", () => {
    const s = setup();
    s.ptt.apply(on());
    s.ptt.setRoom(true);
    s.ptt.dispose();
    expect(s.running()).toBe(false);
  });
});
