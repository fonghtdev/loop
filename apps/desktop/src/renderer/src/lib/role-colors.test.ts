import { describe, expect, it } from "vitest";
import type { Role } from "./permissions";
import { isRoleColor, nameColorOf, ROLE_COLORS } from "./role-colors";

const G = "g";
const role = (id: string, position: number, color?: string | null): Role => ({ id, guildId: G, name: id, permissions: 0, position, color });

describe("nameColorOf", () => {
  const roles = [role(G, 0, "#999999"), role("top", 3), role("mid", 2, "#aa0000"), role("low", 1, "#00bb00")];
  it("takes the highest-position role that HAS a color, skipping uncolored higher ones", () => {
    expect(nameColorOf(["low", "mid", "top"], roles, G)).toBe("#aa0000");
    expect(nameColorOf(["low"], roles, G)).toBe("#00bb00");
  });
  it("undefined when no role has a color; @everyone's color never counts", () => {
    expect(nameColorOf(["top"], roles, G)).toBeUndefined();
    expect(nameColorOf([G], roles, G)).toBeUndefined();
    expect(nameColorOf([], roles, G)).toBeUndefined();
  });
  it("a null color counts as none; ids of deleted roles are ignored", () => {
    expect(nameColorOf(["n", "gone"], [role("n", 5, null)], G)).toBeUndefined();
  });
});

describe("hex validation (same as the server)", () => {
  it("accepts #RRGGBB in either case only", () => {
    for (const ok of ["#a1B2c3", "#000000", "#FFFFFF"]) expect(isRoleColor(ok)).toBe(true);
    for (const bad of ["", "#fff", "a1b2c3", "#a1b2c", "#a1b2c34", "#gggggg", " #a1b2c3", "#a1b2c3\n"]) expect(isRoleColor(bad)).toBe(false);
  });
});

describe("ROLE_COLORS", () => {
  it("has 16 unique valid colors", () => {
    expect(ROLE_COLORS).toHaveLength(16);
    expect(new Set(ROLE_COLORS.map((c) => c.toLowerCase())).size).toBe(16);
    expect(ROLE_COLORS.every(isRoleColor)).toBe(true);
  });
  it("every swatch is light enough for the dark surfaces (contrast >= 4.5 on #23212C)", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const bg = lum("#23212C");
    for (const c of ROLE_COLORS) expect((lum(c) + 0.05) / (bg + 0.05), c).toBeGreaterThanOrEqual(4.5);
  });
});
