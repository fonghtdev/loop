import { describe, expect, it } from "vitest";
import { buildItems, resolveRecents } from "./quick-switch-items";

const guild = { id: "g1", name: "Chúng ta", ownerId: "u", createdAt: "" };
const text = { id: "c1", guildId: "g1", name: "chung", type: "TEXT" as const, position: 0, categoryId: null, overwrites: [] };
const voice = { id: "c2", guildId: "g1", name: "voz", type: "VOICE" as const, position: 1, categoryId: null, overwrites: [] };
const an = { id: "u1", username: "an", status: "offline" as const };
const bo = { id: "u2", username: "bo", status: "online" as const };

describe("buildItems", () => {
  const items = buildItems({ guilds: [guild], channels: { g1: [text, voice] }, dms: [{ id: "d1", user: an, lastMessageAt: null }], friends: [an, bo] });
  it("servers, their channels (with the server as scope), DMs, friends without a DM, and the app places", () => {
    expect(items.map((i) => `${i.kind}:${i.name}`)).toEqual(["server:Chúng ta", "channel:chung", "channel:voz", "dm:an", "friend:bo", "place:Trang chủ", "place:Bạn bè", "place:Cài đặt"]);
    expect(items.find((i) => i.name === "chung")).toMatchObject({ scope: "Chúng ta", sub: "Chúng ta", convKey: "channel:c1" });
    expect(items.find((i) => i.name === "voz")).toMatchObject({ voice: true, sub: "Kênh thoại trong Chúng ta" });
    expect(items.find((i) => i.name === "voz")!.convKey).toBeUndefined();
  });
  it("a friend with a DM is one item (the DM), and a person keeps one key either way", () => {
    expect(items.filter((i) => i.name === "an")).toHaveLength(1);
    expect(items.find((i) => i.name === "an")!.key).toBe("person:u1");
  });
  it("channels not loaded yet are simply absent", () => {
    expect(buildItems({ guilds: [guild], channels: {}, dms: [], friends: [] }).filter((i) => i.kind === "channel")).toEqual([]);
  });
  it("recents resolve to what still exists, in order; the rest is dropped", () => {
    expect(resolveRecents(["person:gone", "person:u2", "channel:g1:c1", "channel:g1:deleted"], items).map((i) => i.name)).toEqual(["bo", "chung"]);
  });
});
