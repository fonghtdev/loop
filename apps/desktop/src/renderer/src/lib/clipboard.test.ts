import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPIED_MS, createCopyState } from "./clipboard";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createCopyState", () => {
  it("idle -> copied -> idle after the delay", () => {
    const seen: boolean[] = [];
    const s = createCopyState((c) => seen.push(c));
    s.copied();
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(COPIED_MS - 1);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true, false]);
  });

  it("copying again while copied restarts the time instead of flipping back early", () => {
    const seen: boolean[] = [];
    const s = createCopyState((c) => seen.push(c));
    s.copied();
    vi.advanceTimersByTime(1000);
    s.copied();
    vi.advanceTimersByTime(1000);
    expect(seen.at(-1)).toBe(true);
    vi.advanceTimersByTime(COPIED_MS);
    expect(seen.at(-1)).toBe(false);
  });

  it("dispose cancels the timer (nothing fires after unmount)", () => {
    const seen: boolean[] = [];
    const s = createCopyState((c) => seen.push(c));
    s.copied();
    s.dispose();
    vi.advanceTimersByTime(COPIED_MS * 3);
    expect(seen).toEqual([true]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reset goes back to idle at once and leaves no timer", () => {
    const seen: boolean[] = [];
    const s = createCopyState((c) => seen.push(c));
    s.copied();
    s.reset();
    expect(seen).toEqual([true, false]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
