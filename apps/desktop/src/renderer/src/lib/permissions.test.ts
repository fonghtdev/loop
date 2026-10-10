import { Permission } from "@loop/shared";
import { describe, expect, it } from "vitest";
import { permissionsFor, type Channel, type PermissionData } from "./permissions";

// Shapes as GET /guilds/:id, /roles and /members return them.
const guild = { id: "g", name: "Nhóm", ownerId: "owner", createdAt: "2026-10-10T00:00:00Z" };
const everyone = { id: "g", guildId: "g", name: "@everyone", permissions: 1811, position: 0 };
const mod = { id: "r-mod", guildId: "g", name: "Mod", permissions: Permission.MANAGE_MESSAGES | Permission.MANAGE_CHANNELS, position: 1 };
const members = [
  { userId: "owner", username: "chu", joinedAt: "", roleIds: [] },
  { userId: "plain", username: "an", joinedAt: "", roleIds: [] },
  { userId: "moderator", username: "binh", joinedAt: "", roleIds: ["r-mod"] },
];
const data = (userId: string): PermissionData => ({ userId, guild, roles: [everyone, mod], members });
const channel = (overwrites: Channel["overwrites"]) => ({ overwrites });
const has = (bits: number, perm: number) => (bits & perm) === perm;

describe("permissionsFor (server-shaped fixtures)", () => {
  it("owner can do everything, even where @everyone is denied", () => {
    const bits = permissionsFor(data("owner"), channel([{ roleId: "g", allow: 0, deny: Permission.VIEW_CHANNEL }]));
    expect(has(bits, Permission.MANAGE_CHANNELS | Permission.SEND_MESSAGES | Permission.CREATE_INVITE)).toBe(true);
  });

  it("a plain member has the @everyone defaults only", () => {
    const bits = permissionsFor(data("plain"));
    expect(has(bits, Permission.SEND_MESSAGES)).toBe(true);
    expect(has(bits, Permission.CREATE_INVITE)).toBe(true);
    expect(has(bits, Permission.MANAGE_CHANNELS)).toBe(false);
    expect(has(bits, Permission.MANAGE_MESSAGES)).toBe(false);
  });

  it("a role with MANAGE_* adds those bits", () => {
    const bits = permissionsFor(data("moderator"));
    expect(has(bits, Permission.MANAGE_MESSAGES)).toBe(true);
    expect(has(bits, Permission.MANAGE_CHANNELS)).toBe(true);
  });

  it("an overwrite denying SEND for @everyone disables sending in that channel only (composer off)", () => {
    const noSend = channel([{ roleId: "g", allow: 0, deny: Permission.SEND_MESSAGES }]);
    expect(has(permissionsFor(data("plain"), noSend), Permission.SEND_MESSAGES)).toBe(false);
    expect(has(permissionsFor(data("plain"), noSend), Permission.VIEW_CHANNEL)).toBe(true);
    expect(has(permissionsFor(data("plain"), channel([])), Permission.SEND_MESSAGES)).toBe(true);
  });

  it("a private channel (VIEW denied for @everyone, allowed for a role) is visible to the role only", () => {
    const priv = channel([
      { roleId: "g", allow: 0, deny: Permission.VIEW_CHANNEL },
      { roleId: "r-mod", allow: Permission.VIEW_CHANNEL, deny: 0 },
    ]);
    expect(permissionsFor(data("plain"), priv)).toBe(0);
    expect(has(permissionsFor(data("moderator"), priv), Permission.SEND_MESSAGES)).toBe(true);
  });

  it("someone no longer in the member list has nothing", () => {
    expect(permissionsFor(data("stranger"))).toBe(0);
  });
});
