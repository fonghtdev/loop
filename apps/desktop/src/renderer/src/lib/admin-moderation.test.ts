import { DEFAULT_EVERYONE_PERMISSIONS, Permission } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { banReasonError, canBan, canSetMemberOverwrite, dropRole, filterMembers, orderAllowed, previewMemberPermissions, roleOrder, settingsSections, shiftRole, standingFor, type Standing } from "./admin";
import { canRevokeInvite, inviteBody, inviteStatus, seesAllInvites } from "./invites";
import { permissionsFor, type Member, type Role } from "./permissions";

// The server's shapes: @everyone has id = guildId at position 0. mod (5, BAN + MANAGE_ROLES) sits under top (8).
const G = "g";
const role = (id: string, position: number, permissions = 0): Role => ({ id, guildId: G, name: id, permissions, position });
const everyone = role(G, 0, DEFAULT_EVERYONE_PERMISSIONS);
const top = role("top", 8);
const mod = role("mod", 5, Permission.BAN_MEMBERS | Permission.MANAGE_ROLES);
const admin = role("admin", 4, Permission.ADMINISTRATOR);
const low = role("low", 2);
const lower = role("lower", 1);
const roles = [everyone, top, mod, admin, low, lower];
const member = (userId: string, ...roleIds: string[]): Member => ({ userId, username: userId, isBot: false, joinedAt: "", createdAt: "", roleIds });
const members = [member("owner"), member("m", "mod"), member("a", "admin"), member("t", "top"), member("l", "low"), member("plain")];
const guild = { id: G, name: "Nhóm", ownerId: "owner", createdAt: "" };
const stand = (userId: string): Standing => standingFor({ userId, guild, roles, members })!;
const target = (id: string) => members.find((m) => m.userId === id)!;

describe("settings tabs for bans and invites", () => {
  it("Cấm needs BAN_MEMBERS; Lời mời needs MANAGE_ROLES or CREATE_INVITE (inside an admin view)", () => {
    expect(settingsSections(Permission.BAN_MEMBERS, false)).toEqual(["members", "bans"]);
    expect(settingsSections(Permission.KICK_MEMBERS | Permission.CREATE_INVITE, false)).toEqual(["members", "invites"]);
    expect(settingsSections(Permission.KICK_MEMBERS, false)).toEqual(["members"]);
    expect(settingsSections(Permission.CREATE_INVITE, false)).toEqual([]); // a plain member still has no settings at all
  });
});

describe("ban gating (mirror of the server's kick hierarchy)", () => {
  it("below you only, never the owner, never yourself; needs the bit", () => {
    const s = stand("m");
    expect(canBan(s, target("l"), "owner", roles)).toBe(true);
    expect(canBan(s, target("plain"), "owner", roles)).toBe(true);
    expect(canBan(s, target("t"), "owner", roles)).toBe(false);
    expect(canBan(s, target("owner"), "owner", roles)).toBe(false);
    expect(canBan(s, target("m"), "owner", roles)).toBe(false);
    expect(canBan({ ...s, bits: s.bits & ~Permission.BAN_MEMBERS }, target("l"), "owner", roles)).toBe(false);
  });
  it("ADMINISTRATOR passes the bit but not the hierarchy; the owner bans anyone else", () => {
    expect(canBan(stand("a"), target("l"), "owner", roles)).toBe(true);
    expect(canBan(stand("a"), target("m"), "owner", roles)).toBe(false);
    expect(canBan(stand("owner"), target("t"), "owner", roles)).toBe(true);
  });
  it("the reason follows the server schema", () => {
    expect(banReasonError("")).toBeUndefined();
    expect(banReasonError("😀".repeat(200))).toBeUndefined();
    expect(banReasonError("a".repeat(201))).toMatch(/200/);
    expect(banReasonError("a‮b")).toBeDefined();
  });
});

describe("role reorder model", () => {
  const order = roleOrder(roles, G);
  it("every role but @everyone, highest first", () => expect(order).toEqual(["top", "mod", "admin", "low", "lower"]));
  it("a non-owner moves only roles below their top, never to or above it", () => {
    const s = stand("m");
    expect(shiftRole(s, roles, G, order, "low", -1)).toEqual(["top", "mod", "low", "admin", "lower"]);
    expect(shiftRole(s, roles, G, order, "admin", -1)).toBeNull(); // would pass the mod
    expect(shiftRole(s, roles, G, order, "mod", 1)).toBeNull(); // their own top
    expect(shiftRole(s, roles, G, order, "top", 1)).toBeNull();
    expect(shiftRole(s, roles, G, order, "lower", 1)).toBeNull(); // already last
    expect(dropRole(s, roles, G, order, "lower", "admin", "before")).toEqual(["top", "mod", "lower", "admin", "low"]);
    expect(dropRole(s, roles, G, order, "lower", "mod", "before")).toBeNull();
    expect(dropRole(s, roles, G, order, "low", "admin", "after")).toBeNull(); // no change
  });
  it("ADMINISTRATOR is held to the same bound; the owner moves anything", () => {
    expect(shiftRole(stand("a"), roles, G, order, "low", -1)).toBeNull(); // would reach the admin role itself
    expect(shiftRole(stand("a"), roles, G, order, "lower", -1)).toEqual(["top", "mod", "admin", "lower", "low"]);
    expect(shiftRole(stand("owner"), roles, G, order, "lower", -1)).toEqual(["top", "mod", "admin", "lower", "low"]);
    expect(dropRole(stand("owner"), roles, G, order, "lower", "top", "before")).toEqual(["lower", "top", "mod", "admin", "low"]);
  });
  it("roles at or above the caller sharing a position: only the owner may reorder", () => {
    const tied = [...roles, role("peer", 5)];
    const s = standingFor({ userId: "m", guild, roles: tied, members })!;
    expect(orderAllowed(s, tied, G, ["top", "mod", "peer", "admin", "low", "lower"])).toBe(false);
    expect(orderAllowed(stand("owner"), tied, G, ["peer", "top"])).toBe(true);
  });
});

describe("member overwrites", () => {
  it("only members strictly below the caller (not the owner, not yourself)", () => {
    const s = stand("m");
    expect(canSetMemberOverwrite(s, target("l"), "owner", roles)).toBe(true);
    expect(canSetMemberOverwrite(s, target("t"), "owner", roles)).toBe(false);
    expect(canSetMemberOverwrite(s, target("owner"), "owner", roles)).toBe(false);
    expect(canSetMemberOverwrite(s, target("m"), "owner", roles)).toBe(false);
  });
  it("the preview runs the shared function with the member's own overwrite applied last", () => {
    const channel = { overwrites: [{ roleId: "low", allow: 0, deny: Permission.SEND_MESSAGES }], memberOverwrites: [{ userId: "other", allow: 0, deny: Permission.VIEW_CHANNEL }] };
    const l = target("l");
    expect(previewMemberPermissions(roles, G, l, channel, { allow: 0, deny: 0 }) & Permission.SEND_MESSAGES).toBe(0);
    expect(previewMemberPermissions(roles, G, l, channel, { allow: Permission.SEND_MESSAGES, deny: 0 }) & Permission.SEND_MESSAGES).toBeTruthy();
    expect(previewMemberPermissions(roles, G, l, channel, { allow: 0, deny: Permission.VIEW_CHANNEL })).toBe(0);
  });
  it("the client's own bits see member overwrites (hidden channel = 0)", () => {
    const channel = { overwrites: [], memberOverwrites: [{ userId: "l", allow: 0, deny: Permission.VIEW_CHANNEL }] };
    expect(permissionsFor({ userId: "l", guild, roles, members }, channel)).toBe(0);
    expect(permissionsFor({ userId: "plain", guild, roles, members }, channel)).toBe(DEFAULT_EVERYONE_PERMISSIONS);
  });
  it("member search ignores accents and case, by name", () => {
    const people = [member("u1"), member("u2")].map((m, i) => ({ ...m, username: ["dat", "an"][i]! }));
    const names: Record<string, string> = { u1: "Đạt", u2: "An" };
    expect(filterMembers(people, "dat", (m) => names[m.userId]!).map((m) => m.userId)).toEqual(["u1"]);
    expect(filterMembers(people, "", (m) => names[m.userId]!).map((m) => m.userId)).toEqual(["u2", "u1"]);
  });
});

describe("invites view model", () => {
  const now = Date.parse("2026-10-16T10:00:00Z");
  const inv = (patch: object) => ({ expiresAt: null, maxUses: null, uses: 0, createdBy: { id: "m", username: "m" }, ...patch });
  it("status: expired, used up or active, as the join check decides", () => {
    expect(inviteStatus(inv({ expiresAt: "2026-10-16T09:59:59Z" }), now)).toBe("expired");
    expect(inviteStatus(inv({ maxUses: 2, uses: 2 }), now)).toBe("used");
    expect(inviteStatus(inv({ maxUses: 2, uses: 1, expiresAt: "2026-10-17T00:00:00Z" }), now)).toBe("active");
  });
  it("the create body carries only the limits that are set", () => {
    expect(inviteBody(null, null)).toEqual({});
    expect(inviteBody(3600, 5)).toEqual({ expiresInSeconds: 3600, maxUses: 5 });
  });
  it("revoke: MANAGE_ROLES any, CREATE_INVITE only one's own", () => {
    const creator: Standing = { userId: "m", isOwner: false, bits: Permission.CREATE_INVITE, top: 0 };
    expect(canRevokeInvite(creator, inv({}))).toBe(true);
    expect(canRevokeInvite(creator, inv({ createdBy: { id: "x", username: "x" } }))).toBe(false);
    expect(canRevokeInvite({ ...creator, bits: Permission.MANAGE_ROLES }, inv({ createdBy: { id: "x", username: "x" } }))).toBe(true);
    expect(canRevokeInvite({ ...creator, bits: 0 }, inv({}))).toBe(false);
    expect(seesAllInvites(creator)).toBe(false);
    expect(seesAllInvites(stand("owner"))).toBe(true);
  });
});
