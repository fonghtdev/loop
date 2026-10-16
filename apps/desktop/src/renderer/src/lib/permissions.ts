import { computePermissions, type MemberOverwrite, type Overwrite, type PresenceStatus } from "@loop/shared";

/** Server shapes (GET /guilds/:id, /guilds/:id/roles, /guilds/:id/members) the client computes permissions from. */
export type Guild = { id: string; name: string; ownerId: string; createdAt: string; iconHash?: string | null };
export type Channel = { id: string; guildId: string; name: string; type: "TEXT" | "VOICE"; position: number; categoryId: string | null; overwrites: Overwrite[]; memberOverwrites?: MemberOverwrite[]; topic?: string | null };
export type Role = { id: string; guildId: string; name: string; permissions: number; position: number; color?: string | null };
export type Member = { userId: string; username: string; isBot: boolean; joinedAt: string; createdAt: string; roleIds: string[]; status?: PresenceStatus; displayName?: string | null; avatarHash?: string | null };

export type PermissionData = { userId: string; guild: Guild; roles: Role[]; members: Member[] };

/**
 * The user's permission bits in the guild, or in `channel` when given, with the same pure function the server
 * uses. Only for hiding/disabling UI: the server decides. Not a member (any more) -> 0.
 */
export function permissionsFor({ userId, guild, roles, members }: PermissionData, channel?: Pick<Channel, "overwrites" | "memberOverwrites">): number {
  const me = members.find((m) => m.userId === userId);
  if (!me) return 0;
  const everyoneRole = roles.find((r) => r.id === guild.id) ?? { id: guild.id, permissions: 0 };
  const memberRoles = roles.filter((r) => me.roleIds.includes(r.id));
  return computePermissions({ isOwner: guild.ownerId === userId, everyoneRole, memberRoles, overwrites: channel?.overwrites, userId, memberOverwrites: channel?.memberOverwrites });
}
