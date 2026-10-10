import { describe, expect, it } from "vitest";
import { compareSeq } from "./seq";

const sort = (xs: string[]) => [...xs].sort(compareSeq);

describe("compareSeq", () => {
  it("orders numerically, not as text ('9' < '10')", () => {
    expect(compareSeq("9", "10")).toBeLessThan(0);
    expect(compareSeq("10", "9")).toBeGreaterThan(0);
    expect(sort(["10", "9", "100", "1", "11"])).toEqual(["1", "9", "10", "11", "100"]);
  });

  it("handles values beyond 2^53 exactly (where Number() would tie)", () => {
    const a = "9007199254740993"; // 2^53 + 1
    const b = "9007199254740992"; // 2^53
    expect(Number(a)).toBe(Number(b)); // the trap
    expect(compareSeq(a, b)).toBeGreaterThan(0);
    expect(sort(["999999999999999999", "100000000000000000", "99999999999999999"])).toEqual([
      "99999999999999999",
      "100000000000000000",
      "999999999999999999",
    ]);
  });

  it("is 0 only for equal values", () => {
    expect(compareSeq("42", "42")).toBe(0);
    expect(compareSeq("42", "43")).toBeLessThan(0);
  });
});
