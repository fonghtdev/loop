import { describe, expect, it } from "vitest";
import { createAppearance, DEFAULT_APPEARANCE, isReducedMotion, parseAppearance } from "./appearance";

const memory = (initial?: string) => {
  const data = new Map<string, string>(initial ? [["loop.appearance", initial]] : []);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};
const makeRoot = () => ({ dataset: {} as Record<string, string | undefined> });

describe("parseAppearance", () => {
  it("defaults: grain on, motion follows the system", () => {
    expect(parseAppearance(null)).toEqual({ grain: "on", motion: "system" });
    expect(parseAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
  });
  it("keeps valid values", () => {
    expect(parseAppearance({ grain: "off", motion: "full" })).toEqual({ grain: "off", motion: "full" });
  });
  it("an unknown value falls back for that field only", () => {
    expect(parseAppearance({ grain: "sepia", motion: "reduced" })).toEqual({ grain: "on", motion: "reduced" });
    expect(parseAppearance({ grain: "off", motion: 3 })).toEqual({ grain: "off", motion: "system" });
    expect(parseAppearance("garbage")).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("createAppearance", () => {
  it("reads what was saved and applies it to the root attributes", () => {
    const root = makeRoot();
    const a = createAppearance(() => memory('{"grain":"off","motion":"reduced"}'), () => root);
    a.init();
    expect(root.dataset).toEqual({ grain: "off", motion: "reduced" });
  });
  it("set() validates, persists, applies and notifies", () => {
    const store = memory();
    const root = makeRoot();
    const a = createAppearance(() => store, () => root);
    let calls = 0;
    a.subscribe(() => calls++);
    a.set({ grain: "off" });
    expect(a.get()).toEqual({ grain: "off", motion: "system" });
    expect(root.dataset.grain).toBe("off");
    expect(JSON.parse(store.data.get("loop.appearance")!)).toEqual({ grain: "off", motion: "system" });
    expect(calls).toBe(1);
    a.set({ motion: "bogus" as never });
    expect(a.get().motion).toBe("system");
  });
  it("corrupt JSON or a throwing storage means defaults and a working app", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    const root = makeRoot();
    const a = createAppearance(() => broken, () => root);
    expect(a.get()).toEqual(DEFAULT_APPEARANCE);
    a.set({ grain: "off" });
    expect(a.get().grain).toBe("off");
    expect(root.dataset.grain).toBe("off");
    expect(createAppearance(() => memory("{not json"), () => root).get()).toEqual(DEFAULT_APPEARANCE);
  });
  it("works without storage or a document (node)", () => {
    const a = createAppearance(() => undefined, () => undefined);
    a.init();
    a.set({ motion: "full" });
    expect(a.get().motion).toBe("full");
  });
});

describe("isReducedMotion", () => {
  it("the in-app choice wins; system follows the OS", () => {
    expect(isReducedMotion("system", true)).toBe(true);
    expect(isReducedMotion("system", false)).toBe(false);
    expect(isReducedMotion("reduced", false)).toBe(true);
    expect(isReducedMotion("full", true)).toBe(false);
  });
});
