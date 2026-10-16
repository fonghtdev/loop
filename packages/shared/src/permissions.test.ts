import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  can,
  computePermissions,
  DEFAULT_EVERYONE_PERMISSIONS,
  Permission as P,
  type PermissionInput,
} from "./permissions.js";
import { createRoleSchema, overwriteSchema } from "./index.js";

const everyone = { id: "guild", permissions: DEFAULT_EVERYONE_PERMISSIONS };
const role = (id: string, permissions = 0) => ({ id, permissions });
const ow = (roleId: string, allow = 0, deny = 0) => ({ roleId, allow, deny });
const member = (patch: Partial<PermissionInput> = {}): PermissionInput => ({
  isOwner: false,
  everyoneRole: everyone,
  memberRoles: [],
  ...patch,
});
const privateChannel = [ow("guild", 0, P.VIEW_CHANNEL), ow("x", P.VIEW_CHANNEL)];
const mo = (userId: string, allow = 0, deny = 0) => ({ userId, allow, deny });
/** The member "me" with role x, in a channel with role and member overwrites. */
const me = (overwrites: ReturnType<typeof ow>[], memberOverwrites: ReturnType<typeof mo>[], patch: Partial<PermissionInput> = {}) =>
  member({ userId: "me", memberRoles: [role("x")], overwrites, memberOverwrites, ...patch });

describe("computePermissions", () => {
  it.each<[string, PermissionInput, number]>([
    ["owner gets every bit, even with nothing granted", member({ isOwner: true, everyoneRole: role("guild") }), ALL_PERMISSIONS],
    ["owner ignores overwrites", member({ isOwner: true, overwrites: [ow("guild", 0, ALL_PERMISSIONS)] }), ALL_PERMISSIONS],
    ["plain @everyone", member(), DEFAULT_EVERYONE_PERMISSIONS],
    ["roles stack with @everyone", member({ memberRoles: [role("a", P.KICK_MEMBERS), role("b", P.MANAGE_ROLES)] }), DEFAULT_EVERYONE_PERMISSIONS | P.KICK_MEMBERS | P.MANAGE_ROLES],
    ["ADMINISTRATOR expands to every bit", member({ memberRoles: [role("a", P.ADMINISTRATOR)] }), ALL_PERMISSIONS],
    ["ADMINISTRATOR on @everyone counts too", member({ everyoneRole: role("guild", P.ADMINISTRATOR) }), ALL_PERMISSIONS],
    ["ADMINISTRATOR bypasses overwrites", member({ memberRoles: [role("a", P.ADMINISTRATOR)], overwrites: [ow("guild", 0, P.VIEW_CHANNEL), ow("a", 0, P.VIEW_CHANNEL)] }), ALL_PERMISSIONS],
    ["channel without overwrites = guild perms", member({ overwrites: [] }), DEFAULT_EVERYONE_PERMISSIONS],
    ["@everyone overwrite denies SEND", member({ overwrites: [ow("guild", 0, P.SEND_MESSAGES)] }), DEFAULT_EVERYONE_PERMISSIONS & ~P.SEND_MESSAGES],
    ["@everyone overwrite allows MANAGE_MESSAGES", member({ overwrites: [ow("guild", P.MANAGE_MESSAGES)] }), DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_MESSAGES],
    ["role allow beats @everyone deny", member({ memberRoles: [role("x")], overwrites: [ow("guild", 0, P.SEND_MESSAGES), ow("x", P.SEND_MESSAGES)] }), DEFAULT_EVERYONE_PERMISSIONS],
    ["role deny beats @everyone allow", member({ memberRoles: [role("x")], overwrites: [ow("guild", P.MANAGE_MESSAGES), ow("x", 0, P.MANAGE_MESSAGES)] }), DEFAULT_EVERYONE_PERMISSIONS],
    ["one role's allow beats another role's deny", member({ memberRoles: [role("x"), role("y")], overwrites: [ow("x", 0, P.SEND_MESSAGES), ow("y", P.SEND_MESSAGES)] }), DEFAULT_EVERYONE_PERMISSIONS],
    ["role deny removes a bit the role itself grants", member({ memberRoles: [role("x", P.MANAGE_MESSAGES)], overwrites: [ow("x", 0, P.MANAGE_MESSAGES)] }), DEFAULT_EVERYONE_PERMISSIONS],
    ["overwrites of roles the member lacks are ignored", member({ memberRoles: [role("x")], overwrites: [ow("y", P.MANAGE_MESSAGES, P.SEND_MESSAGES)] }), DEFAULT_EVERYONE_PERMISSIONS],
    ["private channel: hidden from @everyone", member({ overwrites: privateChannel }), 0],
    ["private channel: visible to role x", member({ memberRoles: [role("x")], overwrites: privateChannel }), DEFAULT_EVERYONE_PERMISSIONS],
    ["no VIEW masks SEND and everything else", member({ memberRoles: [role("a", P.MANAGE_CHANNELS)], overwrites: [ow("guild", 0, P.VIEW_CHANNEL)] }), 0],
    ["no VIEW in the guild masks every channel perm", member({ everyoneRole: role("guild", P.SEND_MESSAGES), overwrites: [] }), 0],
    ["voice bits are in the default @everyone", member(), 19 | P.CONNECT | P.SPEAK | P.VIDEO | P.STREAM],
    ["MOVE_MEMBERS is not in the default @everyone", member(), DEFAULT_EVERYONE_PERMISSIONS & ~P.MOVE_MEMBERS],
    ["MENTION_EVERYONE is not in the default @everyone", member(), DEFAULT_EVERYONE_PERMISSIONS & ~P.MENTION_EVERYONE],
    ["a channel overwrite can allow MOVE_MEMBERS", member({ overwrites: [ow("guild", P.MOVE_MEMBERS)] }), DEFAULT_EVERYONE_PERMISSIONS | P.MOVE_MEMBERS],
    ["channel overwrite denies STREAM only", member({ overwrites: [ow("guild", 0, P.STREAM)] }), DEFAULT_EVERYONE_PERMISSIONS & ~P.STREAM],
    ["channel overwrite denies SPEAK only", member({ overwrites: [ow("guild", 0, P.SPEAK)] }), DEFAULT_EVERYONE_PERMISSIONS & ~P.SPEAK],
    ["role allow of SPEAK beats @everyone deny", member({ memberRoles: [role("x")], overwrites: [ow("guild", 0, P.SPEAK), ow("x", P.SPEAK)] }), DEFAULT_EVERYONE_PERMISSIONS],
    ["no VIEW also masks CONNECT, SPEAK, VIDEO and STREAM", member({ memberRoles: [role("a", P.CONNECT | P.SPEAK | P.VIDEO | P.STREAM)], overwrites: [ow("guild", 0, P.VIEW_CHANNEL)] }), 0],
    ["no VIEW still keeps guild-wide perms outside a channel", member({ everyoneRole: role("guild", P.SEND_MESSAGES) }), P.SEND_MESSAGES],
    ["BAN_MEMBERS is not in the default @everyone", member(), DEFAULT_EVERYONE_PERMISSIONS & ~P.BAN_MEMBERS],
    // member overwrites: applied last, after every role overwrite
    ["member allow beats a role deny", me([ow("x", 0, P.SEND_MESSAGES)], [mo("me", P.SEND_MESSAGES)]), DEFAULT_EVERYONE_PERMISSIONS],
    ["member deny beats a role allow", me([ow("x", P.MANAGE_MESSAGES)], [mo("me", 0, P.MANAGE_MESSAGES)]), DEFAULT_EVERYONE_PERMISSIONS],
    ["member deny beats a role's own bit", me([], [mo("me", 0, P.SEND_MESSAGES)], { memberRoles: [role("x", P.SEND_MESSAGES)] }), DEFAULT_EVERYONE_PERMISSIONS & ~P.SEND_MESSAGES],
    ["member allow beats the @everyone deny", me([ow("guild", 0, P.SPEAK)], [mo("me", P.SPEAK)]), DEFAULT_EVERYONE_PERMISSIONS],
    ["member VIEW deny hides a channel a role opens", me(privateChannel, [mo("me", 0, P.VIEW_CHANNEL)]), 0],
    ["member VIEW allow opens a private channel", me([ow("guild", 0, P.VIEW_CHANNEL)], [mo("me", P.VIEW_CHANNEL)], { memberRoles: [] }), DEFAULT_EVERYONE_PERMISSIONS],
    ["someone else's member overwrite is ignored", me([], [mo("other", 0, P.VIEW_CHANNEL)]), DEFAULT_EVERYONE_PERMISSIONS],
    ["member overwrites are ignored without a userId", member({ overwrites: [], memberOverwrites: [mo("me", 0, P.VIEW_CHANNEL)] }), DEFAULT_EVERYONE_PERMISSIONS],
    ["member overwrites are ignored outside a channel", member({ userId: "me", memberOverwrites: [mo("me", 0, P.VIEW_CHANNEL)] }), DEFAULT_EVERYONE_PERMISSIONS],
    ["the owner ignores a member deny", me([], [mo("me", 0, ALL_PERMISSIONS)], { isOwner: true }), ALL_PERMISSIONS],
    ["ADMINISTRATOR ignores a member deny", me([], [mo("me", 0, P.VIEW_CHANNEL)], { memberRoles: [role("x", P.ADMINISTRATOR)] }), ALL_PERMISSIONS],
  ])("%s", (_name, input, expected) => {
    expect(computePermissions(input)).toBe(expected);
  });
});

describe("can", () => {
  it("needs every requested bit", () => {
    expect(can(member(), P.VIEW_CHANNEL | P.SEND_MESSAGES)).toBe(true);
    expect(can(member(), P.SEND_MESSAGES | P.MANAGE_MESSAGES)).toBe(false);
    expect(can(member({ overwrites: [ow("guild", 0, P.SEND_MESSAGES)] }), P.SEND_MESSAGES)).toBe(false);
    expect(can(member({ overwrites: [ow("guild", 0, P.SEND_MESSAGES)] }), P.VIEW_CHANNEL)).toBe(true);
  });
});

describe("permission input schemas", () => {
  it.each([1 << 18, -1, 1.5, 2 ** 31, "1"])("role permissions reject %j", (permissions) => {
    expect(createRoleSchema.safeParse({ name: "mod", permissions }).success).toBe(false);
  });

  it("overwrites take only channel bits, never both allow and deny", () => {
    expect(overwriteSchema.safeParse({ allow: P.VIEW_CHANNEL, deny: P.SEND_MESSAGES }).success).toBe(true);
    expect(overwriteSchema.safeParse({ allow: P.MANAGE_ROLES, deny: 0 }).success).toBe(false);
    expect(overwriteSchema.safeParse({ allow: P.SEND_MESSAGES, deny: P.SEND_MESSAGES }).success).toBe(false);
  });

  it("voice bits are valid on roles and overwrites, and the default is 3859", () => {
    expect(DEFAULT_EVERYONE_PERMISSIONS).toBe(3859);
    expect(createRoleSchema.safeParse({ name: "dj", permissions: P.CONNECT | P.SPEAK | P.VIDEO | P.STREAM }).success).toBe(true);
    expect(overwriteSchema.safeParse({ allow: P.SPEAK, deny: P.VIDEO | P.CONNECT }).success).toBe(true);
    expect(overwriteSchema.safeParse({ allow: P.MOVE_MEMBERS, deny: 0 }).success).toBe(true);
    expect(createRoleSchema.safeParse({ name: "mod", permissions: P.MOVE_MEMBERS }).success).toBe(true);
  });

  it("BAN_MEMBERS is a guild bit: valid on roles, never in an overwrite", () => {
    expect(P.BAN_MEMBERS).toBe(16384);
    expect(createRoleSchema.safeParse({ name: "mod", permissions: P.BAN_MEMBERS }).success).toBe(true);
    expect(overwriteSchema.safeParse({ allow: P.BAN_MEMBERS, deny: 0 }).success).toBe(false);
  });

  it("VIEW_AUDIT_LOG is a guild bit; MUTE_MEMBERS / DEAFEN_MEMBERS are channel bits; none is in @everyone", () => {
    expect([P.VIEW_AUDIT_LOG, P.MUTE_MEMBERS, P.DEAFEN_MEMBERS]).toEqual([32768, 65536, 131072]);
    expect(createRoleSchema.safeParse({ name: "mod", permissions: P.VIEW_AUDIT_LOG | P.MUTE_MEMBERS | P.DEAFEN_MEMBERS }).success).toBe(true);
    expect(overwriteSchema.safeParse({ allow: P.VIEW_AUDIT_LOG, deny: 0 }).success).toBe(false);
    expect(overwriteSchema.safeParse({ allow: P.MUTE_MEMBERS, deny: P.DEAFEN_MEMBERS }).success).toBe(true);
    expect(DEFAULT_EVERYONE_PERMISSIONS & (P.VIEW_AUDIT_LOG | P.MUTE_MEMBERS | P.DEAFEN_MEMBERS)).toBe(0);
  });

  it("@everyone is reserved as a role name", () => {
    expect(createRoleSchema.safeParse({ name: " @everyone " }).success).toBe(false);
    expect(createRoleSchema.parse({ name: " mod " })).toEqual({ name: "mod", permissions: 0, color: null }); // no color = null
    expect(createRoleSchema.parse({ name: "mod", color: "#12abEF" }).color).toBe("#12abEF");
    expect(createRoleSchema.safeParse({ name: "mod", color: "red" }).success).toBe(false);
  });
});
