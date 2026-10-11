import { describe, expect, it } from "vitest";
import { stageShift, type StagePlace } from "./stage";

const at = (p: Partial<StagePlace>): StagePlace => ({ guildId: null, channelId: null, dmId: null, settings: null, ...p });
const order = ["g1", "g2", "g3"];

describe("stageShift", () => {
  it("nothing changed -> no transition", () => {
    expect(stageShift(at({ guildId: "g1", channelId: "c1" }), at({ guildId: "g1", channelId: "c1" }), order)).toBeNull();
  });
  it("another server slides vertically, down the rail = from below, up = from above", () => {
    expect(stageShift(at({ guildId: "g1", channelId: "c1" }), at({ guildId: "g2" }), order)).toEqual({ x: 0, y: 12 });
    expect(stageShift(at({ guildId: "g3", channelId: "c1" }), at({ guildId: "g1" }), order)).toEqual({ x: 0, y: -12 });
    expect(stageShift(at({ guildId: "g1" }), at({}), order)).toEqual({ x: 0, y: -12 }); // to Home
  });
  it("a channel, a DM or settings slide in from the side", () => {
    expect(stageShift(at({ guildId: "g1", channelId: "c1" }), at({ guildId: "g1", channelId: "c2" }), order)).toEqual({ x: 12, y: 0 });
    expect(stageShift(at({ dmId: "d1" }), at({ dmId: "d2" }), order)).toEqual({ x: 12, y: 0 });
    expect(stageShift(at({ guildId: "g1", channelId: "c1" }), at({ guildId: "g1", channelId: "c1", settings: "user" }), order)).toEqual({ x: 12, y: 0 });
  });
  it("a server resolving its first channel is the same arrival: no second transition", () => {
    expect(stageShift(at({ guildId: "g1", channelId: null }), at({ guildId: "g1", channelId: "c1" }), order)).toBeNull();
  });
});
