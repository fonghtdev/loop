import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { API_URL } from "../../../shared/config";
import type { GuildData } from "./categories";
import { applyGuildUpdated, avatarUrl, bannerUrl, createProfiles, displayNameOf, guildIconUrl, parseGuildUpdated, parseUserUpdated } from "./identity";

const user = { id: "u1", username: "an", displayName: "Anh", avatarHash: "h1", bannerHash: null, statusText: "bận" };

describe("profile store", () => {
  it("seeds display name and avatar from any list, and keeps what other payloads did not say", () => {
    const p = createProfiles();
    expect(p.seed([{ id: "u1", displayName: "Anh", avatarHash: "h1" }], "list")).toBe("list"); // hands the list back
    p.seed([{ id: "u1", statusText: "bận" }], null);
    expect(p.store.getState().byId.u1).toEqual({ displayName: "Anh", avatarHash: "h1", statusText: "bận" });
  });
  it("ignores a payload without the fields (an old server) and values of the wrong type", () => {
    const p = createProfiles();
    p.seed([{ id: "u1" }, { id: "u2", displayName: 5, avatarHash: {} }, { id: undefined as never }], null);
    expect(p.store.getState().byId).toEqual({});
  });
  it("seeding the same thing again changes nothing (subscribers stay quiet)", () => {
    const p = createProfiles();
    p.seed([user], null);
    const listener = vi.fn();
    p.store.subscribe(listener);
    p.seed([user], null);
    p.apply(user);
    expect(listener).not.toHaveBeenCalled();
  });
  it("user:updated replaces every field, so a removed avatar (null) clears the old hash", () => {
    const p = createProfiles();
    p.seed([user], null);
    p.apply({ ...user, avatarHash: null, displayName: null });
    expect(p.store.getState().byId.u1).toMatchObject({ avatarHash: null, displayName: null, statusText: "bận" });
  });
  it("clear forgets everyone (sign-out)", () => {
    const p = createProfiles();
    p.seed([user], null);
    p.clear();
    expect(p.store.getState().byId).toEqual({});
  });
});

describe("displayNameOf", () => {
  it("is the display name when set, else the username (also for an empty name and an unknown user)", () => {
    expect(displayNameOf({ u1: { displayName: "Anh" } }, "u1", "an")).toBe("Anh");
    expect(displayNameOf({ u1: { displayName: null } }, "u1", "an")).toBe("an");
    expect(displayNameOf({ u1: { displayName: "" } }, "u1", "an")).toBe("an");
    expect(displayNameOf({}, "u2", "bo")).toBe("bo");
  });
});

describe("image URLs", () => {
  it("carry the hash as a cache buster on the API origin; no hash means no URL", () => {
    expect(avatarUrl("u1", "h1")).toBe(`${API_URL}/users/u1/avatar?v=h1`);
    expect(bannerUrl("u1", "b2")).toBe(`${API_URL}/users/u1/banner?v=b2`);
    expect(guildIconUrl("g1", "i3")).toBe(`${API_URL}/guilds/g1/icon?v=i3`);
    expect(avatarUrl("u1", null)).toBeNull();
    expect(avatarUrl("u1", undefined)).toBeNull();
    expect(guildIconUrl("g1", "")).toBeNull();
  });
  it("a new hash is a new URL", () => expect(avatarUrl("u1", "a")).not.toBe(avatarUrl("u1", "b")));
});

describe("socket payload parsing", () => {
  it("user:updated needs id, username and all four fields as text or null", () => {
    expect(parseUserUpdated(user)).toEqual(user);
    expect(parseUserUpdated({ ...user, displayName: null })).toMatchObject({ displayName: null });
    for (const bad of [null, undefined, "x", {}, { ...user, id: "" }, { ...user, username: 3 }, { ...user, avatarHash: 1 }, { ...user, statusText: undefined }]) expect(parseUserUpdated(bad)).toBeNull();
  });
  it("guild:updated needs id, name and iconHash as text or null", () => {
    expect(parseGuildUpdated({ id: "g", name: "N", iconHash: null })).toEqual({ id: "g", name: "N", iconHash: null });
    for (const bad of [null, {}, { id: "g", name: "N" }, { id: "g", name: 1, iconHash: null }, { id: "", name: "N", iconHash: null }]) expect(parseGuildUpdated(bad)).toBeNull();
  });
});

describe("applyGuildUpdated", () => {
  const guild = { id: "g", name: "Cũ", ownerId: "o", createdAt: "", iconHash: null };
  const setup = () => {
    const qc = new QueryClient();
    qc.setQueryData(["guilds"], [guild, { ...guild, id: "other" }]);
    qc.setQueryData(["guild", "g"], { guild, channels: [], categories: [] } satisfies GuildData);
    return qc;
  };
  it("renames and re-icons the server in the list and in its own data, only that server", () => {
    const qc = setup();
    applyGuildUpdated(qc, { id: "g", name: "Mới", iconHash: "abc" });
    expect(qc.getQueryData<(typeof guild)[]>(["guilds"])).toMatchObject([{ name: "Mới", iconHash: "abc" }, { id: "other", name: "Cũ", iconHash: null }]);
    expect(qc.getQueryData<GuildData>(["guild", "g"])!.guild).toMatchObject({ name: "Mới", iconHash: "abc" });
  });
  it("is idempotent and leaves caches that are not loaded alone", () => {
    const qc = setup();
    applyGuildUpdated(qc, { id: "g", name: "Mới", iconHash: null });
    const once = qc.getQueryData(["guilds"]);
    applyGuildUpdated(qc, { id: "g", name: "Mới", iconHash: null });
    expect(qc.getQueryData(["guilds"])).toBe(once);
    applyGuildUpdated(qc, { id: "nope", name: "X", iconHash: null });
    expect(qc.getQueryData(["guild", "nope"])).toBeUndefined();
    expect(qc.getQueryData(["guilds"])).toBe(once);
  });
});
