import { describe, expect, it } from "vitest";
import { collapseKey, createCollapse, parseCollapsed } from "./category-collapse";

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe("parseCollapsed", () => {
  it("reads a list of ids; anything else means nothing is folded", () => {
    expect([...parseCollapsed('["a","b"]')]).toEqual(["a", "b"]);
    expect([...parseCollapsed('["a",3,null]')]).toEqual(["a"]);
    for (const bad of [null, undefined, "", "{nope", '{"a":1}', "7"]) expect(parseCollapsed(bad).size).toBe(0);
  });
});

describe("createCollapse", () => {
  it("is all open by default and toggles, saving per account", () => {
    const store = memory();
    const c = createCollapse(() => store);
    c.load("alice");
    expect(c.get().size).toBe(0);
    c.toggle("cat1");
    expect(c.get().has("cat1")).toBe(true);
    expect(store.data.get(collapseKey("alice"))).toBe('["cat1"]');
    c.toggle("cat1");
    expect(c.get().has("cat1")).toBe(false);
  });
  it("a second account never sees the first one's folds, and the first keeps hers; sign-out clears and writes nothing", () => {
    const store = memory();
    const c = createCollapse(() => store);
    c.load("alice");
    c.toggle("cat1");
    c.load("bob");
    expect(c.get().has("cat1")).toBe(false);
    c.load("alice");
    expect(c.get().has("cat1")).toBe(true);
    c.load(null);
    expect(c.get().size).toBe(0);
    c.toggle("cat2");
    expect([...store.data.keys()]).toEqual([collapseKey("alice")]);
  });
  it("survives a relaunch, and a storage that throws only costs persistence", () => {
    const store = memory();
    const first = createCollapse(() => store);
    first.load("u");
    first.toggle("x");
    const second = createCollapse(() => store);
    second.load("u");
    expect(second.get().has("x")).toBe(true);
    const bad = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    const c = createCollapse(() => bad);
    c.load("u");
    c.toggle("x");
    expect(c.get().has("x")).toBe(true);
  });
  it("gives a NEW set on every change and notifies subscribers", () => {
    const c = createCollapse(() => memory());
    c.load("u");
    const before = c.get();
    let n = 0;
    const off = c.subscribe(() => n++);
    c.toggle("x");
    expect(c.get()).not.toBe(before);
    off();
    c.toggle("x");
    expect(n).toBe(1);
  });
});
