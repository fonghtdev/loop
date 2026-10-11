import { describe, expect, it } from "vitest";
import { createToasts } from "./toast";

/** A hand-driven clock + timer, so nothing here sleeps. */
function rig() {
  let t = 0;
  let pending: { at: number; fn: () => void; id: number } | null = null;
  let ids = 0;
  const toasts = createToasts({
    ms: 3000,
    now: () => t,
    setTimer: (fn, ms) => ((pending = { at: t + ms, fn, id: ++ids }), ids),
    clearTimer: (id) => {
      if (pending?.id === id) pending = null;
    },
  });
  const advance = (ms: number) => {
    t += ms;
    if (pending && pending.at <= t) {
      const p = pending;
      pending = null;
      p.fn();
    }
  };
  return { toasts, advance, text: () => toasts.store.getState().current?.text ?? null };
}

describe("toast queue", () => {
  it("shows a message and dismisses it after 3 s", () => {
    const r = rig();
    r.toasts.push("Đã lưu.");
    expect(r.text()).toBe("Đã lưu.");
    r.advance(2999);
    expect(r.text()).toBe("Đã lưu.");
    r.advance(1);
    expect(r.text()).toBeNull();
  });

  it("a new message replaces the one shown (one at a time) and restarts the clock", () => {
    const r = rig();
    r.toasts.push("một");
    r.advance(2000);
    r.toasts.push("hai");
    expect(r.text()).toBe("hai");
    r.advance(2999);
    expect(r.text()).toBe("hai");
    r.advance(1);
    expect(r.text()).toBeNull();
  });

  it("pausing keeps the time left, resuming continues from it", () => {
    const r = rig();
    r.toasts.push("a");
    r.advance(2000);
    r.toasts.pause();
    r.advance(60_000);
    expect(r.text()).toBe("a");
    r.toasts.resume();
    r.advance(999);
    expect(r.text()).toBe("a");
    r.advance(1);
    expect(r.text()).toBeNull();
  });

  it("a message pushed while paused waits, and starts its full time on resume", () => {
    const r = rig();
    r.toasts.push("a");
    r.toasts.pause();
    r.toasts.push("b");
    r.advance(10_000);
    expect(r.text()).toBe("b");
    r.toasts.resume();
    r.advance(3000);
    expect(r.text()).toBeNull();
  });

  it("dismissing by hand clears a pause the vanished element could not end", () => {
    const r = rig();
    r.toasts.push("a");
    r.toasts.pause();
    r.toasts.dismiss();
    r.toasts.push("b");
    r.advance(3000);
    expect(r.text()).toBeNull();
  });

  it("pause and resume with nothing on screen do nothing", () => {
    const r = rig();
    r.toasts.pause();
    r.toasts.resume();
    r.toasts.push("a");
    r.advance(3000);
    expect(r.text()).toBeNull();
  });
});
