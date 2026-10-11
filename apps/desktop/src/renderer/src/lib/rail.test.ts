import { describe, expect, it } from "vitest";
import { pillOffset, PILL_HEIGHT } from "./rail";

describe("pillOffset", () => {
  it("centres the pill on the item", () => {
    expect(pillOffset(12, 48)).toBe(12 + (48 - PILL_HEIGHT) / 2);
    expect(pillOffset(0, 32)).toBe(0);
  });
  it("follows the item down the list (content coordinates, so scrolling the list does not matter)", () => {
    expect(pillOffset(300, 48)).toBeGreaterThan(pillOffset(100, 48));
    expect(pillOffset(300, 48) - pillOffset(100, 48)).toBe(200);
  });
  it("rounds to whole pixels", () => {
    expect(Number.isInteger(pillOffset(10.4, 47))).toBe(true);
  });
});
