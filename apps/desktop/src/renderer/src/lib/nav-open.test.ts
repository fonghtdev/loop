import { describe, expect, it } from "vitest";
import { planOpen, roomPlace } from "./nav";

describe("planOpen", () => {
  it("a text channel is opened", () => expect(planOpen("TEXT", false)).toEqual({ navigate: true, join: false }));
  it("a voice channel we are not in is only joined: the view stays", () => expect(planOpen("VOICE", false)).toEqual({ navigate: false, join: true }));
  it("a voice channel we are in opens its room", () => expect(planOpen("VOICE", true)).toEqual({ navigate: true, join: false }));
});

describe("roomPlace", () => {
  it("leads to the room of a connected channel", () =>
    expect(roomPlace({ kind: "channel", id: "c", name: "x", guildId: "g" })).toEqual({ guildId: "g", channelId: "c", dmId: null, settings: null }));
  it("has none for a DM call, no session, or an unknown server", () => {
    expect(roomPlace({ kind: "dm", id: "d", name: "x" })).toBeNull();
    expect(roomPlace(null)).toBeNull();
    expect(roomPlace({ kind: "channel", id: "c", name: "x" })).toBeNull();
  });
});
