import type { Member, Role } from "./permissions";

export type MemberGroup = {
  /** "owner" | "rest" | the role id. */
  key: string;
  /** The role's name; null for the two fixed groups (their label comes from the dictionary). */
  roleName: string | null;
  members: Member[];
};

const byName = (a: Member, b: Member) => a.username.localeCompare(b.username, "vi");

/**
 * The member column's sections: the owner first, then one group per role (highest role by position first, and each
 * member sits under their HIGHEST role only; `@everyone`, id = guildId, never makes a group), the rest last.
 * `roles` not loaded -> null: the caller shows the flat list.
 */
export function groupMembers(members: Member[], roles: Role[] | undefined, guildId: string, ownerId: string | undefined): MemberGroup[] | null {
  if (!roles) return null;
  const real = new Map(roles.filter((r) => r.id !== guildId && r.position > 0).map((r) => [r.id, r]));
  const owner = members.filter((m) => m.userId === ownerId);
  const byRole = new Map<string, Member[]>();
  const rest: Member[] = [];
  for (const m of members) {
    if (m.userId === ownerId) continue;
    const top = m.roleIds.map((id) => real.get(id)).reduce<Role | undefined>((best, r) => (r && (!best || r.position > best.position) ? r : best), undefined);
    if (!top) rest.push(m);
    else byRole.set(top.id, [...(byRole.get(top.id) ?? []), m]);
  }
  return [
    ...(owner.length ? [{ key: "owner", roleName: null, members: owner }] : []),
    ...[...byRole.entries()]
      .sort(([a], [b]) => real.get(b)!.position - real.get(a)!.position)
      .map(([id, list]) => ({ key: id, roleName: real.get(id)!.name, members: list.sort(byName) })),
    ...(rest.length ? [{ key: "rest", roleName: null, members: rest.sort(byName) }] : []),
  ];
}
