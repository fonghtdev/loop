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
    ["no VIEW still keeps guild-wide perms outside a channel", member({ everyoneRole: role("guild", P.SEND_MESSAGES) }), P.SEND_MESSAGES],
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
  it.each([256, -1, 1.5, 2 ** 31, "1"])("role permissions reject %j", (permissions) => {
    expect(createRoleSchema.safeParse({ name: "mod", permissions }).success).toBe(false);
  });

  it("overwrites take only channel bits, never both allow and deny", () => {
    expect(overwriteSchema.safeParse({ allow: P.VIEW_CHANNEL, deny: P.SEND_MESSAGES }).success).toBe(true);
    expect(overwriteSchema.safeParse({ allow: P.MANAGE_ROLES, deny: 0 }).success).toBe(false);
    expect(overwriteSchema.safeParse({ allow: P.SEND_MESSAGES, deny: P.SEND_MESSAGES }).success).toBe(false);
  });

  it("@everyone is reserved as a role name", () => {
    expect(createRoleSchema.safeParse({ name: " @everyone " }).success).toBe(false);
    expect(createRoleSchema.parse({ name: " mod " })).toEqual({ name: "mod", permissions: 0 });
  });
});
