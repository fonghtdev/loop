import { describe, expect, it } from "vitest";
import { createDensity, DEFAULT_DENSITY, densityKey, parseDensity } from "./density";

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};
const makeRoot = () => ({ dataset: {} as Record<string, string | undefined> });

describe("parseDensity", () => {
  it("keeps the two known values and defaults everything else to comfy", () => {
    expect(parseDensity("compact")).toBe("compact");
    expect(parseDensity("comfy")).toBe("comfy");
    for (const bad of [null, undefined, "", "Compact", "dense", 3, {}]) expect(parseDensity(bad)).toBe(DEFAULT_DENSITY);
  });
});

describe("createDensity", () => {
  it("defaults to comfy and puts it on the root", () => {
    const root = makeRoot();
    const d = createDensity(() => memory(), () => root);
    d.load("u1");
    expect(d.get()).toBe("comfy");
    expect(root.dataset.density).toBe("comfy");
  });

  it("saves per account and a second account never sees the first one's choice", () => {
    const store = memory();
    const root = makeRoot();
    const d = createDensity(() => store, () => root);
    d.load("alice");
    d.set("compact");
    expect(store.data.get(densityKey("alice"))).toBe("compact");
    expect(root.dataset.density).toBe("compact");
    d.load("bob");
    expect(d.get()).toBe("comfy");
    expect(root.dataset.density).toBe("comfy");
    d.set("compact");
    d.set("comfy");
    d.load("alice");
    expect(d.get()).toBe("compact"); // alice kept hers
  });

  it("survives a relaunch (a new instance on the same storage)", () => {
    const store = memory();
    const first = createDensity(() => store, () => makeRoot());
    first.load("u1");
    first.set("compact");
    const second = createDensity(() => store, () => makeRoot());
    second.load("u1");
    expect(second.get()).toBe("compact");
  });

  it("tolerates corrupt storage and a storage that throws", () => {
    const corrupt = createDensity(() => memory({ [densityKey("u1")]: "{not a density" }), () => makeRoot());
    corrupt.load("u1");
    expect(corrupt.get()).toBe("comfy");
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    const d = createDensity(() => throwing, () => makeRoot());
    d.load("u1");
    expect(d.get()).toBe("comfy");
    d.set("compact");
    expect(d.get()).toBe("compact"); // holds for this run
  });

  it("signing out resets to the default and writes nothing", () => {
    const store = memory();
    const d = createDensity(() => store, () => makeRoot());
    d.load("u1");
    d.set("compact");
    d.load(null);
    expect(d.get()).toBe("comfy");
    d.set("compact");
    expect([...store.data.keys()]).toEqual([densityKey("u1")]);
  });

  it("notifies subscribers", () => {
    const d = createDensity(() => memory(), () => makeRoot());
    let n = 0;
    const off = d.subscribe(() => n++);
    d.load("u1");
    d.set("compact");
    off();
    d.set("comfy");
    expect(n).toBe(2);
  });
});
