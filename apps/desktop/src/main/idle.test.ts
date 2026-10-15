import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleWatch, IDLE_AFTER_S, IDLE_POLL_MS } from "./idle";

describe("idle watch", () => {
  let idle = 0;
  const send = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    idle = 0;
    send.mockClear();
  });
  afterEach(() => vi.useRealTimers());
  const tick = () => vi.advanceTimersByTime(IDLE_POLL_MS);

  it("is away exactly at the threshold, not one second before", () => {
    const w = createIdleWatch({ getIdleSeconds: () => idle, send });
    w.start();
    idle = IDLE_AFTER_S - 1;
    tick();
    expect(send).not.toHaveBeenCalled();
    idle = IDLE_AFTER_S;
    tick();
    expect(send.mock.calls).toEqual([[true]]);
  });

  it("sends only on change and resumes as soon as the idle time drops", () => {
    const w = createIdleWatch({ getIdleSeconds: () => idle, send });
    w.start();
    idle = IDLE_AFTER_S + 100;
    tick();
    tick();
    tick();
    expect(send).toHaveBeenCalledTimes(1);
    idle = 2;
    tick();
    tick();
    expect(send.mock.calls).toEqual([[true], [false]]);
  });

  it("never fires after stop(), and start() twice does not double the polling", () => {
    const w = createIdleWatch({ getIdleSeconds: () => idle, send });
    w.start();
    w.start();
    w.stop();
    idle = IDLE_AFTER_S;
    tick();
    expect(send).not.toHaveBeenCalled();
  });
});
