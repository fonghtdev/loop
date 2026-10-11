import { describe, expect, it, vi } from "vitest";
import { BUDGET, budgeted, clampDuration, staggerStep } from "./motion";

describe("clampDuration", () => {
  it("keeps UI motion in 120-260 ms and entrances up to 600 ms", () => {
    expect(clampDuration(40)).toBe(120);
    expect(clampDuration(900)).toBe(260);
    expect(clampDuration(900, "entrance")).toBe(600);
    expect(clampDuration(200)).toBe(200);
  });
});

describe("budgeted", () => {
  it("reduced motion: every property jumps to its end state in 1 ms, no delay", () => {
    const out = budgeted({ opacity: [0, 1], y: { from: 12, to: 0, duration: 400 }, scale: 1.2, duration: 380, delay: 90, ease: "outQuart" }, { reduced: true });
    expect(out).toEqual({ opacity: 1, y: 0, scale: 1.2, duration: 1, delay: 0, ease: "linear" });
  });
  it("full motion: durations are clamped, also per property", () => {
    const out = budgeted({ opacity: { from: 0, to: 1, duration: 5000 }, y: [10, 0], duration: 5000 }, { reduced: false });
    expect(out).toEqual({ opacity: { from: 0, to: 1, duration: 260 }, y: [10, 0], duration: 260 });
  });
  it("only transform and opacity by default: layout properties are dropped with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = budgeted({ width: 200, opacity: 1, duration: 200 }, { reduced: false });
    expect(out).toEqual({ opacity: 1, duration: 200 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(budgeted({ strokeDashoffset: 0, duration: 200 }, { reduced: false, allow: ["strokeDashoffset"] })).toEqual({ strokeDashoffset: 0, duration: 200 });
    warn.mockRestore();
  });
});

describe("staggerStep", () => {
  it("keeps the whole stagger within 500 ms and the sequence within 900 ms", () => {
    expect(staggerStep(8, 24)).toBe(24);
    expect(staggerStep(40, 24)).toBe(Math.floor(500 / 39));
    expect(staggerStep(100, 50, 600)).toBe(Math.floor(300 / 99));
    expect((8 - 1) * staggerStep(8, 100) + 220).toBeLessThanOrEqual(BUDGET.sequenceMax);
    expect(staggerStep(1, 50)).toBe(50);
  });
});
