import type { PresenceStatus } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { groupMembers } from "./member-groups";
import type { Member, Role } from "./permissions";

const G = "g1";
const role = (id: string, name: string, position: number): Role => ({ id, guildId: G, name, permissions: 0, position });
const member = (userId: string, roleIds: string[] = []): Member => ({ userId, username: userId, isBot: false, joinedAt: "2026-01-01", createdAt: "2025-01-01", roleIds });
const roles = [role(G, "@everyone", 0), role("mod", "Điều hành", 2), role("vip", "VIP", 1)];
const on = (...ids: string[]) => (id: string): PresenceStatus => (ids.includes(id) ? "online" : "offline");
const shape = (g: ReturnType<typeof groupMembers>) => g.map((x) => [x.key, x.members.map((m) => m.userId)]);

describe("groupMembers", () => {
  it("online by role (position desc), then online without role, then one offline group", () => {
    const list = [member("zed"), member("ann", ["vip"]), member("bob", ["mod"]), member("off", ["mod"]), member("gone")];
    expect(shape(groupMembers(list, roles, G, on("zed", "ann", "bob")))).toEqual([
      ["mod", ["bob"]],
      ["vip", ["ann"]],
      ["online", ["zed"]],
      ["offline", ["gone", "off"]],
    ]);
  });

  it("idle and dnd count as online", () => {
    const status = (id: string): PresenceStatus => ({ a: "idle", b: "dnd", c: "offline" })[id] as PresenceStatus;
    expect(shape(groupMembers([member("a"), member("b"), member("c")], roles, G, status))).toEqual([
      ["online", ["a", "b"]],
      ["offline", ["c"]],
    ]);
  });

  it("offline people are not split by role, and role names are carried for the headers", () => {
    const g = groupMembers([member("a", ["mod"]), member("b", ["vip"]), member("c")], roles, G, on());
    expect(shape(g)).toEqual([["offline", ["a", "b", "c"]]]);
    expect(groupMembers([member("a", ["mod"])], roles, G, on("a"))[0].roleName).toBe("Điều hành");
  });

  it("several roles -> the highest one only; @everyone and deleted roles make no group", () => {
    expect(shape(groupMembers([member("cy", ["vip", "mod"]), member("dee", [G, "gone"])], roles, G, on("cy", "dee")))).toEqual([
      ["mod", ["cy"]],
      ["online", ["dee"]],
    ]);
  });

  it("empty groups are left out", () => {
    expect(groupMembers([], roles, G, on())).toEqual([]);
    expect(shape(groupMembers([member("a")], roles, G, on("a")))).toEqual([["online", ["a"]]]);
  });

  it("the owner is not special: grouped by role/presence like anyone", () => {
    expect(shape(groupMembers([member("own"), member("x", ["vip"])], roles, G, on("own", "x")))).toEqual([
      ["vip", ["x"]],
      ["online", ["own"]],
    ]);
  });

  it("sorts case-insensitively with Vietnamese collation", () => {
    const names = ["Zoe", "bob", "Đạt", "Anh", "ân", "dũng"].map((n) => member(n));
    const g = groupMembers(names, roles, G, on(...names.map((m) => m.userId)));
    expect(g[0].members.map((m) => m.userId)).toEqual(["Anh", "ân", "bob", "dũng", "Đạt", "Zoe"]);
  });

  it("derived from the inputs: removing/adding a role and a presence change move the member", () => {
    const m = member("a", ["vip"]);
    expect(shape(groupMembers([m], roles, G, on("a")))).toEqual([["vip", ["a"]]]);
    expect(shape(groupMembers([{ ...m, roleIds: [] }], roles, G, on("a")))).toEqual([["online", ["a"]]]);
    expect(shape(groupMembers([{ ...m, roleIds: ["mod"] }], roles, G, on("a")))).toEqual([["mod", ["a"]]]);
    expect(shape(groupMembers([m], roles, G, on()))).toEqual([["offline", ["a"]]]);
  });
});
