import { describe, expect, it } from "vitest";
import { groupMembers } from "./members";
import type { Member, Role } from "./permissions";

const G = "g1";
const role = (id: string, name: string, position: number): Role => ({ id, guildId: G, name, permissions: 0, position });
const everyone = role(G, "@everyone", 0);
const member = (userId: string, roleIds: string[] = []): Member => ({ userId, username: userId, joinedAt: "2026-01-01", roleIds });
const roles = [everyone, role("mod", "Điều hành", 2), role("vip", "VIP", 1)];

describe("groupMembers", () => {
  it("owner first, then roles by position desc, then the rest", () => {
    const groups = groupMembers([member("zed"), member("ann", ["vip"]), member("bob", ["mod"]), member("own")], roles, G, "own")!;
    expect(groups.map((g) => [g.key, g.members.map((m) => m.userId)])).toEqual([
      ["owner", ["own"]],
      ["mod", ["bob"]],
      ["vip", ["ann"]],
      ["rest", ["zed"]],
    ]);
    expect(groups.map((g) => g.roleName)).toEqual([null, "Điều hành", "VIP", null]);
  });

  it("a member with several roles sits under the HIGHEST one only", () => {
    const groups = groupMembers([member("cy", ["vip", "mod"])], roles, G, undefined)!;
    expect(groups.map((g) => g.key)).toEqual(["mod"]);
    expect(groups[0].members).toHaveLength(1);
  });

  it("never makes an @everyone group, even when a member lists it", () => {
    const groups = groupMembers([member("dee", [G]), member("eve")], roles, G, undefined)!;
    expect(groups.map((g) => g.key)).toEqual(["rest"]);
    expect(groups[0].members.map((m) => m.userId)).toEqual(["dee", "eve"]);
  });

  it("the owner is not repeated under a role, empty groups are left out, ids of deleted roles are ignored", () => {
    const groups = groupMembers([member("own", ["mod"]), member("fay", ["gone"])], roles, G, "own")!;
    expect(groups.map((g) => g.key)).toEqual(["owner", "rest"]);
  });

  it("sorts names inside a group and counts are the group sizes", () => {
    const groups = groupMembers([member("b", ["vip"]), member("a", ["vip"]), member("c", ["vip"])], roles, G, undefined)!;
    expect(groups[0].members.map((m) => m.userId)).toEqual(["a", "b", "c"]);
    expect(groups[0].members.length).toBe(3);
  });

  it("roles not loaded -> null (flat list)", () => {
    expect(groupMembers([member("a")], undefined, G, "a")).toBeNull();
  });
});
