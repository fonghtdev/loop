import type { PresenceStatus } from "@loop/shared";
import type { Member, Role } from "./permissions";

export type MemberGroup = {
  /** "online" (no role), "offline", or the role id. */
  key: string;
  /** The role's name; null for the two fixed groups (their label comes from the dictionary). */
  roleName: string | null;
  members: Member[];
};

const collator = new Intl.Collator("vi", { sensitivity: "base" });
const byName = (a: Member, b: Member) => collator.compare(a.username, b.username);

/**
 * The member column, Discord style: online (online, idle, dnd) people under their highest real role (by position, desc),
 * online people without a role next, then ONE offline group. @everyone (id = guildId) never makes a group; the owner is
 * not special. Empty groups are left out; names sort case-insensitively. Derived on every call: nothing is copied.
 */
export function groupMembers(members: Member[], roles: Role[], guildId: string, statusOf: (userId: string) => PresenceStatus): MemberGroup[] {
  const real = new Map(roles.filter((r) => r.id !== guildId && r.position > 0).map((r) => [r.id, r]));
  const byRole = new Map<string, Member[]>();
  const online: Member[] = [];
  const offline: Member[] = [];
  for (const m of members) {
    if (statusOf(m.userId) === "offline") {
      offline.push(m);
      continue;
    }
    const top = m.roleIds.reduce<Role | undefined>((best, id) => {
      const r = real.get(id);
      return r && (!best || r.position > best.position) ? r : best;
    }, undefined);
    if (!top) online.push(m);
    else byRole.set(top.id, [...(byRole.get(top.id) ?? []), m]);
  }
  const groups = (list: Member[], key: string, roleName: string | null): MemberGroup[] => (list.length ? [{ key, roleName, members: list.sort(byName) }] : []);
  return [
    ...[...byRole.entries()].sort(([a], [b]) => real.get(b)!.position - real.get(a)!.position).flatMap(([id, list]) => groups(list, id, real.get(id)!.name)),
    ...groups(online, "online", null),
    ...groups(offline, "offline", null),
  ];
}
