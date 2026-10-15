import type { Role } from "./permissions";

/** 16 hues picked to stay readable (>= 4.5:1) on the dark cosmic surfaces; the role editor offers exactly these. */
export const ROLE_COLORS = [
  "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#4ade80", "#34d399", "#2dd4bf", "#22d3ee",
  "#38bdf8", "#60a5fa", "#818cf8", "#a78bfa", "#c084fc", "#e879f9", "#f472b6", "#cbd5e1",
] as const;

/** Dot color of a role without a color of its own. */
export const NEUTRAL_ROLE_COLOR = "#8e8a9c";

/** Same rule as the server's `roleColorSchema`. */
export const isRoleColor = (v: string) => /^#[0-9A-Fa-f]{6}$/.test(v);

/** A person's name color: the color of their highest-position role that has one (@everyone never counts); undefined = default text color. */
export function nameColorOf(roleIds: readonly string[], roles: readonly Role[], guildId: string): string | undefined {
  let best: Role | undefined;
  for (const r of roles) if (r.id !== guildId && r.color && roleIds.includes(r.id) && (!best || r.position > best.position)) best = r;
  return best?.color ?? undefined;
}
