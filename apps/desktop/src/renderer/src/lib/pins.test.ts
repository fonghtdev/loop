import { describe, expect, it } from "vitest";
import type { Message } from "./chat";
import { pinRows, pinsPath, pinRights } from "./pins";

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id, channelId: "c1", dmChannelId: null, attachments: [], author: { id: "u", username: "u" }, content: id, createdAt: "2026-10-10T00:00:00Z", editedAt: null, seq: "1", pinned: true, ...over,
});

describe("pinsPath", () => {
  it("a channel and a DM have their own list", () => {
    expect(pinsPath("channel:c1")).toBe("/channels/c1/pins");
    expect(pinsPath("dm:d1")).toBe("/dms/d1/pins");
  });
});

describe("pinRights", () => {
  it("a channel needs MANAGE_MESSAGES for both, whatever else is allowed", () => {
    expect(pinRights("channel:c1", { canManage: false, canWrite: true })).toEqual({ pin: false, unpin: false });
    expect(pinRights("channel:c1", { canManage: true, canWrite: false })).toEqual({ pin: true, unpin: true });
  });
  it("a DM pins while the friendship stands, and always lets a pin go", () => {
    expect(pinRights("dm:d1", { canManage: false, canWrite: true })).toEqual({ pin: true, unpin: true });
    expect(pinRights("dm:d1", { canManage: false, canWrite: false })).toEqual({ pin: false, unpin: true });
  });
});

describe("pinRows", () => {
  it("keeps the server's order and says which messages the list can scroll to", () => {
    const rows = pinRows([msg("b"), msg("a")], [msg("a")]);
    expect(rows.map((r) => [r.message.id, r.loaded])).toEqual([["b", false], ["a", true]]);
  });
  it("shows the loaded copy (an edit since the list was fetched)", () => {
    const rows = pinRows([msg("a", { content: "old" })], [msg("a", { content: "new" })]);
    expect(rows[0]!.message.content).toBe("new");
  });
  it("drops what the loaded copy says was unpinned, before the refetch lands", () => {
    expect(pinRows([msg("a"), msg("b")], [msg("a", { pinned: false })]).map((r) => r.message.id)).toEqual(["b"]);
  });
  it("an empty list stays empty", () => {
    expect(pinRows([], [msg("a")])).toEqual([]);
  });
});
