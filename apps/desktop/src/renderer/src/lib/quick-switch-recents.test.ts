import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecentKey, MAX_RECENTS, parseRecents, pushRecent, readRecents, recentKeyOf, recordRecent } from "./quick-switch-recents";

const id = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const person = (n: number) => `person:${id(n)}`;

describe("recents", () => {
  it("pushes to the front, once, up to 8", () => {
    let list: string[] = [];
    for (let n = 1; n <= 10; n++) list = pushRecent(list, person(n));
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0]).toBe(person(10));
    expect(pushRecent(list, person(5))[0]).toBe(person(5));
    expect(pushRecent(list, person(5)).filter((k) => k === person(5))).toHaveLength(1);
  });
  it("validates ids and shapes on read: corrupt, unknown or hostile entries are dropped", () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents("not json")).toEqual([]);
    expect(parseRecents('{"a":1}')).toEqual([]);
    const ok = `channel:${id(1)}:${id(2)}`;
    expect(parseRecents(JSON.stringify([ok, "person:xyz", "channel:1:2", 5, null, "place:evil", "place:home", `person:${id(1)}<script>`]))).toEqual([ok, "place:home"]);
  });
  it("dedupes and caps what it reads, keeping the most recent", () => {
    const raw = JSON.stringify([person(1), person(2), person(1), ...Array.from({ length: 12 }, (_, n) => person(n + 3))]);
    const out = parseRecents(raw);
    expect(out).toHaveLength(MAX_RECENTS);
    expect(out[0]).toBe(person(1));
    expect(new Set(out).size).toBe(out.length);
  });
  it("only the stored key formats are accepted", () => {
    expect(isRecentKey(`channel:${id(1)}:${id(2)}`)).toBe(true);
    expect(isRecentKey(`group:${id(1)}`)).toBe(true);
    expect(isRecentKey(`guild:${id(1)}`)).toBe(false);
    expect(isRecentKey("place:friends")).toBe(true);
  });
  it("names where the user is: a channel, a DM's person, Friends, settings; unknown DMs and bare servers are nothing", () => {
    const dms = [{ id: id(9), user: { id: id(8) } }, { id: id(6), kind: "GROUP" }];
    const here = { guildId: null, channelId: null, dmId: null, settings: null };
    expect(recentKeyOf({ ...here, guildId: id(1), channelId: id(2) }, dms)).toBe(`channel:${id(1)}:${id(2)}`);
    expect(recentKeyOf({ ...here, guildId: id(1) }, dms)).toBeNull();
    expect(recentKeyOf({ ...here, dmId: id(9) }, dms)).toBe(person(8));
    expect(recentKeyOf({ ...here, dmId: id(6) }, dms)).toBe(`group:${id(6)}`);
    expect(recentKeyOf({ ...here, dmId: id(7) }, dms)).toBeNull();
    expect(recentKeyOf(here, dms)).toBe("place:friends");
    expect(recentKeyOf({ ...here, settings: "user" }, dms)).toBe("place:settings");
  });
});

describe("recents storage", () => {
  const fake = () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
    return data;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("each account has its own list (loop.recents.<userId>)", () => {
    const data = fake();
    recordRecent("alice", person(1));
    recordRecent("bob", person(2));
    recordRecent("alice", person(3));
    expect(readRecents("alice")).toEqual([person(3), person(1)]);
    expect(readRecents("bob")).toEqual([person(2)]);
    expect([...data.keys()].sort()).toEqual(["loop.recents.alice", "loop.recents.bob"]);
  });
  it("blocked or throwing storage is harmless", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(readRecents("alice")).toEqual([]);
    expect(() => recordRecent("alice", person(1))).not.toThrow();
  });
});
