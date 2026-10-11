import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTooltipTimer, TOOLTIP_DELAY } from "./tooltip";

const setup = () => {
  const show = vi.fn();
  const hide = vi.fn();
  return { show, hide, tip: createTooltipTimer(show, hide) };
};
beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("tooltip timing", () => {
  it("shows only after the hover delay, sooner for keyboard focus", () => {
    const { show, tip } = setup();
    tip.enter("hover");
    vi.advanceTimersByTime(TOOLTIP_DELAY.hover - 1);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledTimes(1);
    const f = setup();
    f.tip.enter("focus");
    vi.advanceTimersByTime(TOOLTIP_DELAY.focus);
    expect(f.show).toHaveBeenCalledTimes(1);
    expect(TOOLTIP_DELAY.focus).toBeLessThan(TOOLTIP_DELAY.hover);
  });
  it("leaving before the delay never shows it", () => {
    const { show, hide, tip } = setup();
    tip.enter("hover");
    vi.advanceTimersByTime(200);
    tip.leave();
    vi.advanceTimersByTime(1000);
    expect(show).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });
  it("leave hides a visible tooltip", () => {
    const { hide, tip } = setup();
    tip.enter("hover");
    vi.advanceTimersByTime(500);
    tip.leave();
    expect(hide).toHaveBeenCalledTimes(1);
  });
  it("Escape hides at once and keeps it hidden until the pointer leaves", () => {
    const { show, hide, tip } = setup();
    tip.enter("hover");
    vi.advanceTimersByTime(500);
    tip.escape();
    expect(hide).toHaveBeenCalledTimes(1);
    tip.enter("hover");
    vi.advanceTimersByTime(1000);
    expect(show).toHaveBeenCalledTimes(1);
    tip.leave();
    tip.enter("hover");
    vi.advanceTimersByTime(500);
    expect(show).toHaveBeenCalledTimes(2);
  });
  it("Escape during the delay cancels the pending show", () => {
    const { show, tip } = setup();
    tip.enter("focus");
    tip.escape();
    vi.advanceTimersByTime(1000);
    expect(show).not.toHaveBeenCalled();
  });
  it("a second enter while one is pending does not restart or double-show", () => {
    const { show, tip } = setup();
    tip.enter("hover");
    vi.advanceTimersByTime(300);
    tip.enter("focus");
    vi.advanceTimersByTime(100);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
