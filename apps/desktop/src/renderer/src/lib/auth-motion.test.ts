import { describe, expect, it } from "vitest";
import { entrancePlan } from "./auth-motion";
import { BUDGET } from "./motion";

describe("entrancePlan", () => {
  it("ends inside the 900 ms sequence ceiling for any number of items", () => {
    for (const count of [0, 1, 3, 7, 12, 40, 200]) {
      const plan = entrancePlan(count, false)!;
      expect(plan.end, `${count} items`).toBeLessThanOrEqual(BUDGET.sequenceMax);
    }
  });
  it("staggers the typical auth screen at the designed 35 ms and ends well before the ceiling", () => {
    const plan = entrancePlan(7, false)!;
    expect(plan.itemStep).toBe(35);
    expect(plan.end).toBeLessThanOrEqual(850);
  });
  it("squeezes the step, never the ceiling, when there are many items", () => {
    expect(entrancePlan(40, false)!.itemStep).toBeLessThan(35);
  });
  it("reduced motion: no choreography at all", () => {
    expect(entrancePlan(7, true)).toBeNull();
  });
});
