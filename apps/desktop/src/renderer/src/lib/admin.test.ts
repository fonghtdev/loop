import { ALL_PERMISSIONS, CHANNEL_PERMISSIONS, Permission } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { vi } from "../i18n/vi";
import {
  canHandOutRole,
  canManageMember,
  canManageRole,
  CHANNEL_BITS,
  grantableBits,
  guardSettings,
  nameMatches,
  patchRole,
  PERMISSION_GROUPS,
  previewPermissions,
  setBit,
  setTri,
  settingsSections,
  standingFor,
  topPosition,
  triOf,
  unknownBits,
  type Standing,
  type Tri,
  channelPatch,
  guildNameError,
  topicError,
} from "./admin";
import type { Member, Role } from "./permissions";

// Fixtures in the server's shapes: @everyone has id = guildId and position 0; new roles stack upward from 1.
const G = "g";
const role = (id: string, position: number, permissions: number): Role => ({ id, guildId: G, name: id, permissions, position });
const everyone = role(G, 0, 1811);
const newbie = role("newbie", 1, Permission.MANAGE_MESSAGES);
const helper = role("helper", 2, Permission.MANAGE_MESSAGES | Permission.KICK_MEMBERS);
const mod = role("mod", 3, Permission.MANAGE_ROLES | Permission.KICK_MEMBERS | Permission.MANAGE_MESSAGES);
const boss = role("boss", 4, Permission.ADMINISTRATOR);
const roles = [everyone, newbie, helper, mod, boss];
const member = (userId: string, ...roleIds: string[]): Member => ({ userId, username: userId, isBot: false, joinedAt: "", createdAt: "", roleIds });
const members = [member("owner"), member("plain"), member("n", "newbie"), member("h", "helper"), member("m", "mod"), member("b", "boss"), member("k", "helper"), member("mm", "mod")];
const guild = { id: G, name: "Nhóm", ownerId: "owner", createdAt: "" };
const stand = (userId: string): Standing => standingFor({ userId, guild, roles, members })!;

describe("settings gating", () => {
  const sections = (userId: string) => {
    const s = stand(userId);
    return settingsSections(s.bits, s.isOwner);
  };
  it("a plain member sees no entry at all", () => expect(sections("plain")).toEqual([]));
  it("the owner sees every section including the dangerous one", () => expect(sections("owner")).toEqual(["overview", "roles", "members", "bans", "invites", "overwrites", "automod", "audit", "danger"]));
  it("ADMINISTRATOR (not owner) sees all but the owner-only section", () => expect(sections("b")).toEqual(["overview", "roles", "members", "bans", "invites", "overwrites", "automod", "audit"]));
  it("VIEW_AUDIT_LOG alone opens the settings with the log; AutoMod stays owner / ADMINISTRATOR", () => {
    expect(settingsSections(Permission.VIEW_AUDIT_LOG, false)).toEqual(["members", "audit"]);
    expect(settingsSections(ALL_PERMISSIONS & ~Permission.ADMINISTRATOR, false)).not.toContain("automod");
  });
  it("MANAGE_ROLES only: roles, members, every invite and overwrites", () => {
    expect(settingsSections(Permission.MANAGE_ROLES, false)).toEqual(["roles", "members", "invites", "overwrites"]);
  });
  it("the overview (name and icon of the server) needs ADMINISTRATOR or ownership, MANAGE_ROLES alone is not enough", () => {
    expect(settingsSections(Permission.ADMINISTRATOR, false)[0]).toBe("overview");
    expect(settingsSections(Permission.MANAGE_ROLES | Permission.MANAGE_CHANNELS, false)).not.toContain("overview");
    expect(settingsSections(0, true)[0]).toBe("overview");
  });
  it("KICK_MEMBERS only: just the member list", () => expect(settingsSections(Permission.KICK_MEMBERS, false)).toEqual(["members"]));
  it("MANAGE_CHANNELS only: just the member list", () => expect(settingsSections(Permission.MANAGE_CHANNELS, false)).toEqual(["members"]));
  it("bits that are not admin actions open nothing", () => {
    expect(settingsSections(Permission.MANAGE_MESSAGES | Permission.CREATE_INVITE | 1811, false)).toEqual([]);
  });
});

describe("server and channel identity forms", () => {
  it("guildNameError mirrors the server schema (1..100 after trimming)", () => {
    expect(guildNameError("Nhóm")).toBeUndefined();
    expect(guildNameError("   ")).toMatch(/Vui lòng điền/);
    expect(guildNameError("a".repeat(101))).toMatch(/100/);
  });
  it("topicError allows empty and multi-line text, refuses control characters and over 1024 characters", () => {
    expect(topicError("")).toBeUndefined();
    expect(topicError("dòng 1\ndòng 2")).toBeUndefined();
    expect(topicError("a\u0007b")).toBeDefined();
    expect(topicError("😀".repeat(1024))).toBeUndefined(); // counted in characters, not UTF-16 units
    expect(topicError("😀".repeat(1025))).toMatch(/1024/);
  });
  it("channelPatch sends only what changed; a cleared topic is null; nothing changed is null", () => {
    const c = { name: "chung", topic: "cũ" };
    expect(channelPatch(c, { name: "chung", topic: "cũ" })).toBeNull();
    expect(channelPatch(c, { name: "moi", topic: "cũ" })).toEqual({ name: "moi" });
    expect(channelPatch(c, { name: "chung", topic: "  " })).toEqual({ topic: null });
    expect(channelPatch({ name: "chung" }, { name: "chung", topic: "" })).toBeNull(); // no topic stays no topic
  });
});

describe("guardSettings (restored or open view is re-checked)", () => {
  it("keeps an allowed tab", () => expect(guardSettings("roles", ["roles", "members"])).toBe("roles"));
  it("moves to the first allowed tab when the tab is no longer allowed (ownership lost)", () => expect(guardSettings("danger", ["roles", "members"])).toBe("roles"));
  it("closes when nothing is allowed any more", () => expect(guardSettings("roles", [])).toBeNull());
  it("stays closed", () => expect(guardSettings(null, ["roles"])).toBeNull());
});

describe("hierarchy helpers mirror the server", () => {
  it("topPosition: highest role, @everyone only = 0", () => {
    expect(topPosition([], roles)).toBe(0);
    expect(topPosition(["newbie", "mod"], roles)).toBe(3);
  });
  it("standing: owner outranks every role, others use their top", () => {
    expect(stand("owner").top).toBe(Infinity);
    expect(stand("m").top).toBe(3);
  });
  it("canManageRole: strictly below the top; equal and above are read-only", () => {
    const m = stand("m");
    expect(canManageRole(m, helper)).toBe(true);
    expect(canManageRole(m, mod)).toBe(false); // equal
    expect(canManageRole(m, boss)).toBe(false); // above
    expect(canManageRole(m, everyone)).toBe(true); // position 0 < top
  });
  it("canManageRole: the owner passes everything; ADMINISTRATOR does not bypass the hierarchy", () => {
    expect(canManageRole(stand("owner"), boss)).toBe(true);
    expect(canManageRole(stand("b"), boss)).toBe(false);
    expect(canManageRole(stand("b"), mod)).toBe(true);
  });
  it("a caller with only @everyone cannot manage even @everyone", () => expect(canManageRole(stand("plain"), everyone)).toBe(false));

  const target = (id: string) => members.find((m) => m.userId === id)!;
  const may = (who: string, whom: string, action: "kick" | "roles") => canManageMember(stand(who), target(whom), "owner", roles, action);
  it("kick/assign: only members strictly below the caller's top", () => {
    expect(may("m", "h", "kick")).toBe(true);
    expect(may("m", "mm", "kick")).toBe(false); // equal top
    expect(may("m", "b", "kick")).toBe(false); // above
    expect(may("m", "plain", "roles")).toBe(true);
  });
  it("nobody but the owner may touch the owner; the owner may assign roles to themselves but not kick themselves", () => {
    expect(may("b", "owner", "kick")).toBe(false);
    expect(may("b", "owner", "roles")).toBe(false);
    expect(may("owner", "owner", "kick")).toBe(false);
    expect(may("owner", "owner", "roles")).toBe(true);
  });
  it("self: no kick, role changes allowed (the server still applies rules 1 and 2b)", () => {
    expect(may("m", "m", "kick")).toBe(false);
    expect(may("m", "m", "roles")).toBe(true);
  });
  it("the owner may act on anyone else", () => {
    expect(may("owner", "b", "kick")).toBe(true);
    expect(may("owner", "m", "roles")).toBe(true);
  });
});

describe("grantable bits and handing out roles (rules 2 and 2b)", () => {
  it("only the bits the caller holds, within the scope", () => {
    expect(grantableBits(Permission.MANAGE_ROLES | Permission.SEND_MESSAGES)).toBe(Permission.MANAGE_ROLES | Permission.SEND_MESSAGES);
    expect(grantableBits(Permission.MANAGE_ROLES | Permission.SEND_MESSAGES, CHANNEL_PERMISSIONS)).toBe(Permission.SEND_MESSAGES);
    expect(grantableBits(0)).toBe(0);
  });
  it("owner and ADMINISTRATOR hold every bit", () => {
    expect(grantableBits(stand("owner").bits)).toBe(ALL_PERMISSIONS);
    expect(grantableBits(stand("b").bits)).toBe(ALL_PERMISSIONS);
  });
  it("a role below the caller whose bits the caller holds can be handed out", () => {
    expect(canHandOutRole(stand("m"), helper, [])).toBe(true);
  });
  it("not a role with bits the caller lacks (helper has KICK; a caller with MANAGE_ROLES only does not)", () => {
    const s: Standing = { userId: "x", isOwner: false, bits: Permission.MANAGE_ROLES | Permission.VIEW_CHANNEL, top: 3 };
    expect(canHandOutRole(s, helper, [])).toBe(false);
  });
  it("not a role whose overwrite in a channel the caller does not hold there", () => {
    const channels = [{ overwrites: [{ roleId: "helper", allow: Permission.SEND_MESSAGES, deny: 0 }], bits: Permission.VIEW_CHANNEL }];
    expect(canHandOutRole(stand("m"), helper, channels)).toBe(false);
    expect(canHandOutRole(stand("m"), newbie, channels)).toBe(true); // the overwrite is helper's
  });
  it("not @everyone, not a role at or above the top", () => {
    expect(canHandOutRole(stand("owner"), everyone, [])).toBe(false);
    expect(canHandOutRole(stand("m"), mod, [])).toBe(false);
  });
});

describe("PATCH body is a diff", () => {
  it("nothing changed -> nothing to send", () => expect(patchRole(helper, { name: helper.name, permissions: helper.permissions, color: null })).toBeNull());
  it("only the changed field goes", () => {
    expect(patchRole(helper, { name: "Trợ lý", permissions: helper.permissions, color: null })).toEqual({ name: "Trợ lý" });
    expect(patchRole(helper, { name: helper.name, permissions: Permission.MANAGE_MESSAGES, color: null })).toEqual({ permissions: Permission.MANAGE_MESSAGES });
  });
  it("the name is trimmed before comparing", () => expect(patchRole(helper, { name: ` ${helper.name} `, permissions: helper.permissions, color: null })).toBeNull());
  it("color: set, change, clear (null) and untouched", () => {
    expect(patchRole(helper, { name: helper.name, permissions: helper.permissions, color: "#112233" })).toEqual({ color: "#112233" });
    const red = { ...helper, color: "#ff0000" };
    expect(patchRole(red, { name: red.name, permissions: red.permissions, color: "#ff0000" })).toBeNull();
    expect(patchRole(red, { name: red.name, permissions: red.permissions, color: null })).toEqual({ color: null });
  });
  it("@everyone never sends a name", () => expect(patchRole(everyone, { name: "x", permissions: everyone.permissions, color: null })).toBeNull());
  it("unknown bits survive a toggle of a known one", () => {
    const UNKNOWN = 1 << 20;
    const odd = role("odd", 5, Permission.SEND_MESSAGES | UNKNOWN);
    expect(unknownBits(odd.permissions)).toBe(UNKNOWN);
    const next = setBit(odd.permissions, Permission.VIDEO, true);
    expect(patchRole(odd, { name: odd.name, permissions: next, color: null })).toEqual({ permissions: Permission.SEND_MESSAGES | UNKNOWN | Permission.VIDEO });
    expect(patchRole(odd, { name: odd.name, permissions: setBit(next, Permission.VIDEO, false), color: null })).toBeNull();
  });
});

describe("permission label table", () => {
  const listed = PERMISSION_GROUPS.flatMap((g) => g.items);
  it("has exactly one entry per Permission bit, each with a label and a description", () => {
    expect(listed.map((i) => i.name).sort()).toEqual(Object.keys(Permission).sort());
    for (const i of listed) {
      expect(vi[i.label], i.label).toBeTruthy();
      expect(vi[i.desc], i.desc).toBeTruthy();
    }
  });
  it("the channel rows are exactly the bits an overwrite accepts", () => {
    expect(CHANNEL_BITS.reduce((all, i) => all | Permission[i.name], 0)).toBe(CHANNEL_PERMISSIONS);
  });
});

describe("tri-state overwrite mapping", () => {
  const bits = Object.values(Permission).filter((b) => b & CHANNEL_PERMISSIONS);
  const states: Tri[] = ["allow", "inherit", "deny"];
  it("round-trips every bit and state, never touches the other bits, never both allowed and denied", () => {
    for (const bit of bits)
      for (const from of states)
        for (const to of states) {
          const other = bits.filter((b) => b !== bit);
          let o = { allow: 0, deny: 0 };
          for (const b of other) o = setTri(o, b, "allow");
          o = setTri(o, bit, from);
          o = setTri(o, bit, to);
          expect(triOf(o, bit)).toBe(to);
          expect(o.allow & o.deny).toBe(0);
          for (const b of other) expect(triOf(o, b)).toBe("allow");
        }
  });
  it("deny after allow moves the bit across", () => {
    const o = setTri(setTri({ allow: 0, deny: 0 }, Permission.VIEW_CHANNEL, "allow"), Permission.VIEW_CHANNEL, "deny");
    expect(o).toEqual({ allow: 0, deny: Permission.VIEW_CHANNEL });
  });
  it("all inherit = both zero (this is what becomes a DELETE)", () => {
    expect(setTri({ allow: 0, deny: Permission.SEND_MESSAGES }, Permission.SEND_MESSAGES, "inherit")).toEqual({ allow: 0, deny: 0 });
  });
});

describe("overwrite preview uses the shared algorithm", () => {
  it("deny VIEW for @everyone hides the channel from a role-less preview, a role allow brings it back", () => {
    const ows = [{ roleId: G, allow: 0, deny: Permission.VIEW_CHANNEL }];
    expect(previewPermissions(roles, G, G, ows, { allow: 0, deny: Permission.VIEW_CHANNEL })).toBe(0);
    const withRole = previewPermissions(roles, G, "helper", ows, { allow: Permission.VIEW_CHANNEL, deny: 0 });
    expect(withRole & Permission.VIEW_CHANNEL).toBe(Permission.VIEW_CHANNEL);
    expect(withRole & Permission.SEND_MESSAGES).toBe(Permission.SEND_MESSAGES);
  });
  it("the draft replaces the saved overwrite of that role", () => {
    const ows = [{ roleId: G, allow: 0, deny: Permission.SEND_MESSAGES }];
    expect(previewPermissions(roles, G, G, ows, { allow: 0, deny: 0 }) & Permission.SEND_MESSAGES).toBe(Permission.SEND_MESSAGES);
  });
});

describe("typed confirmation", () => {
  it("accepts the exact name (surrounding spaces ignored) and nothing else", () => {
    expect(nameMatches("Nhóm", "Nhóm")).toBe(true);
    expect(nameMatches("  Nhóm ", "Nhóm")).toBe(true);
    expect(nameMatches("nhóm", "Nhóm")).toBe(false);
    expect(nameMatches("Nhó", "Nhóm")).toBe(false);
    expect(nameMatches("", "Nhóm")).toBe(false);
  });
});
