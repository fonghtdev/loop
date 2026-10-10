import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePlace, readLastPlace, writeLastPlace } from "./nav";

const HOME = { guildId: null, channelId: null, dmId: null, settings: null };

describe("parsePlace", () => {
  it("restores a server and channel, a DM, and Friends", () => {
    expect(parsePlace('{"guildId":"g1","channelId":"c1","dmId":null}')).toEqual({ guildId: "g1", channelId: "c1", dmId: null, settings: null });
    expect(parsePlace('{"guildId":null,"channelId":null,"dmId":"d1"}')).toEqual({ guildId: null, channelId: null, dmId: "d1", settings: null });
    expect(parsePlace('{"guildId":null,"channelId":null,"dmId":null}')).toEqual(HOME);
  });
  it("restores an open settings tab with its server; an unknown tab or one without a server is dropped", () => {
    expect(parsePlace('{"guildId":"g1","channelId":null,"dmId":null,"settings":"roles"}')).toEqual({ guildId: "g1", channelId: null, dmId: null, settings: "roles" });
    expect(parsePlace('{"guildId":"g1","channelId":null,"settings":"root"}').settings).toBeNull();
    expect(parsePlace('{"guildId":null,"dmId":"d1","settings":"roles"}')).toEqual({ guildId: null, channelId: null, dmId: "d1", settings: null });
  });
  it("reads the 9b format (no dmId)", () => {
    expect(parsePlace('{"guildId":"g1","channelId":"c1"}')).toEqual({ guildId: "g1", channelId: "c1", dmId: null, settings: null });
  });
  it("one place at a time: a server wins over a DM", () => {
    expect(parsePlace('{"guildId":"g1","channelId":null,"dmId":"d1"}')).toEqual({ guildId: "g1", channelId: null, dmId: null, settings: null });
  });
  it.each([null, "", "garbage", "42", '"str"', '{"guildId":5,"channelId":{}}'])("anything unexpected is Home: %s", (raw) => {
    expect(parsePlace(raw)).toEqual(HOME);
  });
});

describe("last place in localStorage (per user)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (store: Record<string, string>) =>
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) });

  it("round-trips per user", () => {
    const store: Record<string, string> = {};
    stub(store);
    writeLastPlace("u1", { guildId: null, channelId: null, dmId: "d7", settings: null });
    writeLastPlace("u2", { guildId: "g", channelId: "c", dmId: null, settings: null });
    expect(readLastPlace("u1")).toEqual({ guildId: null, channelId: null, dmId: "d7", settings: null });
    expect(readLastPlace("u2")).toEqual({ guildId: "g", channelId: "c", dmId: null, settings: null });
    expect(readLastPlace("nobody")).toEqual(HOME);
  });
  it("storage that throws is harmless", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readLastPlace("u1")).toEqual(HOME);
    expect(() => writeLastPlace("u1", HOME)).not.toThrow();
  });
});
