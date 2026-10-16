import { DEFAULT_EVERYONE_PERMISSIONS, Permission } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { canDropOn, encodeMove, isMoveDrag, mayMove, moveOptions, parseMove, seatOf } from "./move-members";
import type { Channel } from "./permissions";
import { LAYOUT_DRAG, hasFiles, isLayoutDrag } from "./drop";

const ch = (id: string, type: Channel["type"] = "VOICE", guildId = "g"): Channel => ({ id, guildId, name: id, type, position: 0, categoryId: null, overwrites: [] });
const CHANNELS = [ch("v1"), ch("v2"), ch("v3"), ch("t1", "TEXT")];
const ALL = DEFAULT_EVERYONE_PERMISSIONS | Permission.MOVE_MEMBERS;
const seats = (...ids: string[]) => ids.map((userId) => ({ userId, username: userId }));

describe("MOVE_MEMBERS on the client", () => {
  it("a default member does not have it, a holder does", () => {
    expect(mayMove(DEFAULT_EVERYONE_PERMISSIONS)).toBe(false);
    expect(mayMove(ALL)).toBe(true);
  });
});

describe("drag payload", () => {
  it("round-trips and rejects anything else", () => {
    const p = { userId: "u", guildId: "g", channelId: "v1" };
    expect(parseMove(encodeMove(p))).toEqual(p);
    for (const bad of ["", "nope", "null", "[]", '{"userId":"u"}', '{"userId":1,"guildId":"g","channelId":"v1"}'])
      expect(parseMove(bad), bad).toBeNull();
  });
  it("is its own drag type: not files, not the channel layout drag", () => {
    const dt = { types: ["application/x-loop-move"] };
    expect(isMoveDrag(dt)).toBe(true);
    expect(hasFiles(dt)).toBe(false);
    expect(isLayoutDrag(dt)).toBe(false);
    expect(isMoveDrag({ types: [LAYOUT_DRAG, "Files"] })).toBe(false);
    expect(isMoveDrag(null)).toBe(false);
  });
});

describe("drop target", () => {
  const drag = { userId: "u", guildId: "g", channelId: "v1" };
  it("accepts another voice channel of the same server where we may move people", () => {
    expect(canDropOn(drag, ch("v2"), ALL)).toBe(true);
  });
  it.each([
    ["the channel the person is in", ch("v1"), ALL],
    ["without the right there", ch("v2"), DEFAULT_EVERYONE_PERMISSIONS],
    ["a text channel", ch("t1", "TEXT"), ALL],
    ["a channel of another server", ch("v2", "VOICE", "other"), ALL],
  ])("refuses %s", (_name, dest, bits) => {
    expect(canDropOn(drag, dest, bits)).toBe(false);
  });
});

describe("where someone sits and where they may go", () => {
  const bitsOf = (c: Pick<Channel, "overwrites">) => (c === CHANNELS[2] ? DEFAULT_EVERYONE_PERMISSIONS : ALL);
  const lists = { v1: seats("a", "b"), v2: seats("c") };
  it("finds the voice channel from the lists, and from the live room when it is ours", () => {
    expect(seatOf("a", CHANNELS, lists, null)?.id).toBe("v1");
    expect(seatOf("z", CHANNELS, lists, null)).toBeNull();
    expect(seatOf("a", CHANNELS, { v1: [] }, { channelId: "v2", participants: seats("a") })?.id).toBe("v2");
  });
  it("lists the other voice channels with the right, never text channels or the current one", () => {
    expect(moveOptions({ userId: "a", channels: CHANNELS, lists, live: null, bitsOf })?.targets.map((c) => c.id)).toEqual(["v2"]);
  });
  it("is hidden when the person is in no channel, we lack the right in their channel, or there is nowhere to go", () => {
    expect(moveOptions({ userId: "z", channels: CHANNELS, lists, live: null, bitsOf })).toBeNull();
    expect(moveOptions({ userId: "a", channels: CHANNELS, lists, live: null, bitsOf: () => DEFAULT_EVERYONE_PERMISSIONS })).toBeNull();
    expect(moveOptions({ userId: "a", channels: CHANNELS, lists, live: null, bitsOf: (c) => (c === CHANNELS[0] ? ALL : DEFAULT_EVERYONE_PERMISSIONS) })).toBeNull();
  });
});
