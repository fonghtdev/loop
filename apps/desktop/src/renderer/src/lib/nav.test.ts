import { afterEach, describe, expect, it, vi } from "vitest";
import { openConversation, parsePlace, placeForKey, readLastPlace, writeLastPlace } from "./nav";

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

describe("the user settings place", () => {
  it("is restored with or without a server (it is always valid for a signed-in user)", () => {
    expect(parsePlace('{"guildId":null,"dmId":"d1","settings":"user"}')).toEqual({ guildId: null, channelId: null, dmId: "d1", settings: "user" });
    expect(parsePlace('{"guildId":"g1","channelId":"c1","settings":"user"}')).toEqual({ guildId: "g1", channelId: "c1", dmId: null, settings: "user" });
  });
});

describe("openConversation / placeForKey", () => {
  const place = { guildId: null, channelId: null, dmId: null, settings: null };
  it("the conversation on screen; a settings view covers it", () => {
    expect(openConversation({ ...place, dmId: "d1" })).toBe("dm:d1");
    expect(openConversation({ ...place, guildId: "g", channelId: "c" })).toBe("channel:c");
    expect(openConversation({ ...place, dmId: "d1", settings: "user" })).toBeNull();
    expect(openConversation(place)).toBeNull();
  });
  it("a notification click leads to a DM only while it is still in the list", () => {
    expect(placeForKey("dm:d1", ["d1", "d2"])).toEqual({ ...place, dmId: "d1" });
    expect(placeForKey("dm:gone", ["d1"])).toBeNull();
    expect(placeForKey("dm:d1", undefined)).toBeNull();
    expect(placeForKey("channel:c1", ["c1"])).toBeNull();
  });
});
