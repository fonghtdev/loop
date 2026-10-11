import { describe, expect, it } from "vitest";
import { INDICATOR_BASE, indicatorSpot, nextTab } from "./tabs";

describe("indicatorSpot", () => {
  it("a tab as wide as the base sits at its left edge unscaled", () => {
    expect(indicatorSpot(0, INDICATOR_BASE)).toEqual({ x: 0, scaleX: 1 });
  });
  it("moves with the tab's left edge and stretches with its width", () => {
    expect(indicatorSpot(120, 60)).toEqual({ x: 120, scaleX: 0.6 });
    expect(indicatorSpot(250.456, 150)).toEqual({ x: 250.46, scaleX: 1.5 });
  });
  it("a tab with no width yet collapses instead of going negative", () => {
    expect(indicatorSpot(10, -4).scaleX).toBe(0);
  });
});

describe("nextTab (keyboard roving)", () => {
  it("arrows wrap around, Home and End jump", () => {
    expect(nextTab(3, 2, "ArrowRight")).toBe(0);
    expect(nextTab(3, 0, "ArrowLeft")).toBe(2);
    expect(nextTab(3, 1, "Home")).toBe(0);
    expect(nextTab(3, 0, "End")).toBe(2);
  });
  it("other keys are left alone", () => {
    expect(nextTab(3, 0, "a")).toBe(-1);
  });
});
