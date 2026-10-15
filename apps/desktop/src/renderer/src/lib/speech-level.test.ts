import { describe, expect, it } from "vitest";
import { createSpeechDetector, rmsDb } from "./speech-level";

describe("speech detector", () => {
  it("fires on the first loud sample", () => {
    const d = createSpeechDetector();
    expect(d(-70, 0)).toBe(false);
    expect(d(-30, 50)).toBe(true);
  });
  it("silence and a noise floor stay false", () => {
    const d = createSpeechDetector();
    for (let t = 0; t < 2000; t += 50) expect(d(t % 100 ? -Infinity : -60, t)).toBe(false);
  });
  it("holds through a short dip, then releases after the hold", () => {
    const d = createSpeechDetector();
    d(-30, 0);
    expect(d(-80, 100)).toBe(true);
    expect(d(-80, 299)).toBe(true);
    expect(d(-80, 300)).toBe(false);
  });
  it("hysteresis: between the thresholds does not start, but keeps it going", () => {
    const d = createSpeechDetector();
    expect(d(-51, 0)).toBe(false); // below onDb
    d(-30, 50);
    expect(d(-51, 1000)).toBe(true); // above offDb: still speech, hold keeps refreshing
    expect(d(-80, 1100)).toBe(true);
    expect(d(-80, 1350)).toBe(false);
  });
  it("loud again inside the hold restarts it", () => {
    const d = createSpeechDetector();
    d(-30, 0);
    d(-30, 250);
    expect(d(-80, 500)).toBe(true);
    expect(d(-80, 560)).toBe(false);
  });
  it("detectors are independent", () => {
    const [a, b] = [createSpeechDetector(), createSpeechDetector()];
    a(-30, 0);
    expect([a(-80, 10), b(-80, 10)]).toEqual([true, false]);
  });
  it("rmsDb: full-scale square = 0 dBFS, silence = -Infinity", () => {
    expect(rmsDb(new Float32Array(8).fill(1))).toBeCloseTo(0);
    expect(rmsDb(new Float32Array(8))).toBe(-Infinity);
  });
});
