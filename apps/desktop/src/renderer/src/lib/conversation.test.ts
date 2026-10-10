import { describe, expect, it } from "vitest";
import { channelKey, dmKey, messagesPath, parseKey, uploadTarget } from "./conversation";

describe("conversation keys", () => {
  it("a channel and a DM with the same id are different conversations", () => {
    expect(channelKey("x")).not.toBe(dmKey("x"));
  });
  it("round-trips and picks the REST path and upload target by kind", () => {
    expect(parseKey(channelKey("abc"))).toEqual({ kind: "channel", id: "abc" });
    expect(parseKey(dmKey("abc"))).toEqual({ kind: "dm", id: "abc" });
    expect(messagesPath(channelKey("c9"))).toBe("/channels/c9/messages");
    expect(messagesPath(dmKey("d9"))).toBe("/dms/d9/messages");
    expect(uploadTarget(channelKey("c9"))).toEqual({ channelId: "c9" });
    expect(uploadTarget(dmKey("d9"))).toEqual({ dmChannelId: "d9" });
  });
});
