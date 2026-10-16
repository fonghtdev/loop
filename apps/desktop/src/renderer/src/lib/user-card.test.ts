import { Permission } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { standingFor, type SettingsCtx } from "./admin";
import type { Member, Role } from "./permissions";
import type { FriendsData } from "./social";
import { NEUTRAL_ROLE_COLOR } from "./role-colors";
import { cardActions, cardDate, cardIdentity, filterRoles, modView, placeCard, relationOf, roleChips, roleColor, rolesView, stepIndex } from "./user-card";

const G = "g";
const role = (id: string, position: number, permissions: number): Role => ({ id, guildId: G, name: id, permissions, position });
const everyone = role(G, 0, 1811);
const newbie = role("newbie", 1, Permission.MANAGE_MESSAGES);
const helper = role("helper", 2, Permission.MANAGE_MESSAGES | Permission.KICK_MEMBERS);
const mod = role("mod", 3, Permission.MANAGE_ROLES | Permission.KICK_MEMBERS | Permission.MANAGE_MESSAGES);
const roles = [everyone, newbie, helper, mod];
const member = (userId: string, ...roleIds: string[]): Member => ({ userId, username: userId, joinedAt: "", createdAt: "", isBot: false, roleIds });
const members = [member("owner"), member("plain"), member("m", "mod"), member("h", "helper"), member("n", "newbie")];
const guild = { id: G, name: "G", ownerId: "owner", createdAt: "" };
const ctxFor = (userId: string): SettingsCtx => ({
  guildId: G,
  guildName: "G",
  ownerId: "owner",
  standing: standingFor({ userId, guild, roles, members })!,
  roles,
  members,
  channels: [],
});
const target = (id: string) => members.find((m) => m.userId === id)!;

describe("cardActions", () => {
  const base = { selfId: "me", userId: "u", isBot: false, relation: "none" as const, blocked: false, hasDm: false };
  it("offers nothing on yourself", () => {
    expect(cardActions({ ...base, userId: "me", relation: "friend", hasDm: true })).toEqual({ message: null, friend: null, block: null });
  });
  it("a stranger: add friend and block, but no DM (the server needs a friendship)", () => {
    expect(cardActions(base)).toEqual({ message: null, friend: "add", block: "block" });
  });
  it("a friend: message (create the DM), unfriend, block", () => {
    expect(cardActions({ ...base, relation: "friend" })).toEqual({ message: "create", friend: "unfriend", block: "block" });
  });
  it("an existing DM is simply opened, even after the friendship ended", () => {
    expect(cardActions({ ...base, hasDm: true }).message).toBe("open");
  });
  it("pending requests: accept an incoming one, cancel an outgoing one", () => {
    expect(cardActions({ ...base, relation: "incoming" }).friend).toBe("accept");
    expect(cardActions({ ...base, relation: "outgoing" }).friend).toBe("cancel");
  });
  it("a bot can only be blocked: no friend request, no DM", () => {
    expect(cardActions({ ...base, isBot: true })).toEqual({ message: null, friend: null, block: "block" });
  });
  it("a blocked person can only be unblocked", () => {
    expect(cardActions({ ...base, blocked: true, relation: "friend", hasDm: true })).toEqual({ message: null, friend: null, block: "unblock" });
  });
});

describe("relation", () => {
  const friends: FriendsData = { friends: [{ id: "f", username: "f", status: "online" }], incoming: [{ id: "i", username: "i" }], outgoing: [{ id: "o", username: "o" }] };
  it("relationOf reads the three lists", () => {
    expect(["f", "i", "o", "x"].map((id) => relationOf(id, friends))).toEqual(["friend", "incoming", "outgoing", "none"]);
    expect(relationOf("f", undefined)).toBe("none");
  });
});

describe("cardDate", () => {
  it("formats for Vietnamese readers", () => expect(cardDate("2026-03-05T12:00:00Z")).toBe("5 tháng 3, 2026"));
  it("is empty for missing or invalid input instead of 'Invalid Date'", () => {
    expect(cardDate(undefined)).toBe("");
    expect(cardDate("nope")).toBe("");
  });
});

describe("roleChips", () => {
  it("drops @everyone, ignores roles the member lacks, highest position first", () => {
    expect(roleChips([G, "newbie", "mod", "helper"], roles, G).map((r) => r.id)).toEqual(["mod", "helper", "newbie"]);
  });
});

describe("placeCard", () => {
  const view = { width: 1000, height: 700 };
  const card = { width: 300, height: 400 };
  it("sits under the anchor, left edges aligned", () => {
    expect(placeCard({ left: 100, top: 50, width: 200, height: 20 }, card, view)).toEqual({ left: 100, top: 78 });
  });
  it("flips above when it would overflow the bottom", () => {
    expect(placeCard({ left: 100, top: 500, width: 200, height: 20 }, card, view)).toEqual({ left: 100, top: 92 });
  });
  it("is pulled back inside at the right edge (the members column)", () => {
    expect(placeCard({ left: 900, top: 50, width: 90, height: 20 }, card, view).left).toBe(692);
  });
  it("never leaves the viewport even when it fits neither side", () => {
    const p = placeCard({ left: -50, top: 200, width: 20, height: 20 }, { width: 300, height: 680 }, view);
    expect(p).toEqual({ left: 8, top: 8 });
  });
});

describe("modView (admin part of the card)", () => {
  it("a plain member can do nothing", () => {
    const v = modView(ctxFor("plain"), target("n"));
    expect(v.kick).toBe(false);
    expect(v.assignable).toEqual([]);
  });
  it("a moderator may assign only roles strictly below their top, never @everyone", () => {
    expect(modView(ctxFor("m"), target("plain")).assignable.map((r) => r.id)).toEqual(["helper", "newbie"]);
  });
  it("roles the member already holds move from assignable to removable", () => {
    const v = modView(ctxFor("m"), target("n"));
    expect(v.assignable.map((r) => r.id)).toEqual(["helper"]);
    expect([...v.removable]).toEqual(["newbie"]);
  });
  it("a moderator cannot touch someone of equal or higher standing, nor the owner", () => {
    const equal = member("m2", "mod");
    expect(modView({ ...ctxFor("m"), members: [...members, equal] }, equal)).toMatchObject({ kick: false, assignable: [] });
    expect(modView(ctxFor("m"), target("owner")).kick).toBe(false);
  });
  it("kick follows KICK_MEMBERS: a helper kicks a newbie, a newbie kicks no one", () => {
    expect(modView(ctxFor("h"), target("plain")).kick).toBe(true);
    expect(modView(ctxFor("n"), target("plain")).kick).toBe(false);
  });
  it("a helper (KICK but no MANAGE_ROLES) kicks without assigning roles", () => {
    expect(modView(ctxFor("h"), target("plain")).assignable).toEqual([]);
  });
  it("the owner may assign every real role", () => {
    expect(modView(ctxFor("owner"), target("plain")).assignable.map((r) => r.id)).toEqual(["mod", "helper", "newbie"]);
  });
});

describe("roles block (Discord-like card)", () => {
  it("regression: the caller may add roles even when nothing is left to hand out", () => {
    // the moderator already gave "plain" every role below their top: assignable is empty but "+" must stay
    const full = member("full", "helper", "newbie");
    const v = modView({ ...ctxFor("m"), members: [...members, full] }, full);
    expect(v.assignable).toEqual([]);
    expect(v.canRoles).toBe(true);
    expect(rolesView({ chipCount: 2, mod: v }).canAdd).toBe(true);
  });
  it("the plus shows with no role and with one role; nobody who cannot manage roles gets it", () => {
    expect(rolesView({ chipCount: 0, mod: modView(ctxFor("m"), target("plain")) })).toEqual({ show: true, canAdd: true });
    expect(rolesView({ chipCount: 1, mod: modView(ctxFor("m"), target("n")) })).toEqual({ show: true, canAdd: true });
    expect(rolesView({ chipCount: 1, mod: modView(ctxFor("h"), target("n")) })).toEqual({ show: true, canAdd: false });
  });
  it("no right and no roles hides the block; the roles are not loaded yet (mod null) behaves the same", () => {
    expect(rolesView({ chipCount: 0, mod: modView(ctxFor("plain"), target("n")) }).show).toBe(false);
    expect(rolesView({ chipCount: 0, mod: null }).show).toBe(false);
    expect(rolesView({ chipCount: 2, mod: null })).toEqual({ show: true, canAdd: false });
  });
  it("the owner gets the block on their own card (add and remove), like anyone else", () => {
    const own = target("owner");
    const view = modView(ctxFor("owner"), own);
    expect(rolesView({ chipCount: 0, mod: view })).toEqual({ show: true, canAdd: true });
    expect(view.assignable.map((r) => r.id)).toEqual(["mod", "helper", "newbie"]);
  });
  it("a manager cannot add roles to the owner (canRoles false)", () => {
    expect(modView(ctxFor("m"), target("owner")).canRoles).toBe(false);
  });
});

describe("filterRoles / stepIndex", () => {
  it("filters by name substring, ignoring case and surrounding spaces; empty query keeps all", () => {
    const rs = [role("a", 1, 0), { ...role("b", 2, 0), name: "Quản trị" }, { ...role("c", 3, 0), name: "Khách" }];
    expect(filterRoles(rs, "  QUẢN ").map((r) => r.id)).toEqual(["b"]);
    expect(filterRoles(rs, "").length).toBe(3);
    expect(filterRoles(rs, "zzz")).toEqual([]);
  });
  it("arrow keys wrap around; an empty list has no row", () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

describe("roleColor", () => {
  it("uses the role's own color, stable", () => {
    expect(roleColor({ color: "#123456" })).toBe("#123456");
    expect(roleColor({ color: "#123456" })).toBe(roleColor({ color: "#123456" }));
  });
  it("a role without color (missing or null) gets the same neutral color, whatever its id", () => {
    expect(roleColor({})).toBe(NEUTRAL_ROLE_COLOR);
    expect(roleColor({ color: null })).toBe(NEUTRAL_ROLE_COLOR);
  });
});

describe("cardIdentity (the head of the card)", () => {
  it("falls back to the username when nobody told a display name", () => {
    expect(cardIdentity("an", undefined, undefined)).toEqual({ title: "an", handle: null, statusText: null, bannerHash: null, bio: null });
  });
  it("a display name is the title and @username becomes the small handle", () => {
    expect(cardIdentity("an", { displayName: "Anh Nhỏ" }, undefined)).toMatchObject({ title: "Anh Nhỏ", handle: "@an" });
  });
  it("the fetched profile wins over the store, including a removed name or status (null)", () => {
    const stored = { displayName: "Cũ", statusText: "bận", bannerHash: "b1" };
    const r = cardIdentity("an", stored, { displayName: null, statusText: null, bannerHash: "b2", bio: "Xin chào" });
    expect(r).toEqual({ title: "an", handle: null, statusText: null, bannerHash: "b2", bio: "Xin chào" });
  });
  it("while the profile loads (or failed) the card still shows what the store knows", () => {
    expect(cardIdentity("an", { displayName: "Anh", statusText: "rảnh", bannerHash: "b1" }, undefined)).toMatchObject({ title: "Anh", statusText: "rảnh", bannerHash: "b1", bio: null });
  });
});
