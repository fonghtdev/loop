import { describe, expect, it, vi } from "vitest";
import { createNoiseLevel, DEFAULT_NOISE_LEVEL, noiseConfig, parseNoiseLevel } from "./noise";

describe("noiseConfig", () => {
  it("off keeps the browser's filter and runs nothing", () => {
    expect(noiseConfig("off")).toEqual({ browserNoiseSuppression: true, rnnoise: false, gate: null });
  });
  it("standard is RNNoise alone, the browser's filter off so two filters do not stack", () => {
    expect(noiseConfig("standard")).toEqual({ browserNoiseSuppression: false, rnnoise: true, gate: null });
  });
  it("strong is RNNoise plus a gate", () => {
    const c = noiseConfig("strong");
    expect(c).toMatchObject({ browserNoiseSuppression: false, rnnoise: true });
    expect(c.gate).toMatchObject({ holdMs: expect.any(Number) });
    expect(c.gate!.closeDb).toBeLessThanOrEqual(c.gate!.openDb);
  });
});

describe("stored level", () => {
  it.each([null, "", "loud", "STANDARD", "1"])("%j reads as the default (standard)", (raw) => {
    expect(parseNoiseLevel(raw)).toBe(DEFAULT_NOISE_LEVEL);
    expect(DEFAULT_NOISE_LEVEL).toBe("standard");
  });
  it.each(["off", "standard", "strong"] as const)("keeps %s", (l) => expect(parseNoiseLevel(l)).toBe(l));

  it("saves a change, reads it back in the next run, and tells the session", () => {
    let stored: string | null = null;
    const storage = { read: () => stored, write: (v: string) => void (stored = v) };
    const onChange = vi.fn();
    const a = createNoiseLevel({ storage, onChange });
    expect(a.get()).toBe("standard");
    a.set("strong");
    expect(stored).toBe("strong");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(createNoiseLevel({ storage, onChange }).get()).toBe("strong");
  });
  it("storage that throws still gives the default and still applies a change", () => {
    const storage = { read: () => { throw new Error("x"); }, write: () => { throw new Error("x"); } };
    const onChange = vi.fn();
    const n = createNoiseLevel({ storage, onChange });
    expect(n.get()).toBe("standard");
    n.set("off");
    expect(n.get()).toBe("off");
    expect(onChange).toHaveBeenCalled();
  });
});
