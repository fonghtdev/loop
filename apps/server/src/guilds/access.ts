import type { Role } from "@prisma/client";
import { computePermissions, hasPermission, Permission, type Overwrite } from "@loop/shared";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError } from "../http.js";

export const NOT_FOUND = new HttpError(404, "Not found");
export const isUuid = (id: string) => z.string().uuid().safeParse(id).success;
const forbidden = (message = "Missing permission") => new HttpError(403, message);

/** `roles` = the guild's @everyone (id = guildId) plus the member's own roles. */
const permissionInput = (guild: { id: string; ownerId: string }, userId: string, roles: Role[]) => ({
  isOwner: guild.ownerId === userId,
  everyoneRole: roles.find((r) => r.id === guild.id)!, // always exists: created with the guild, backfilled by migration
  memberRoles: roles.filter((r) => r.id !== guild.id),
});

/**
 * The caller's standing in a guild, loaded once: guild-wide permission bits and `top`, the highest
 * position among their roles (0 = only @everyone; the owner outranks every role).
 * Every guild/channel/message route starts here. Non-members, malformed and unknown ids all get 404,
 * never 403, so a guild's existence does not leak.
 */
export async function requireMember(guildId: string, userId: string) {
  const row = isUuid(guildId)
    ? await prisma.guild.findFirst({
        where: { id: guildId, members: { some: { userId } } },
        include: { roles: { where: { OR: [{ id: guildId }, { members: { some: { userId } } }] } } },
      })
    : null;
  if (!row) throw NOT_FOUND;
  const { roles, ...guild } = row;
  const input = permissionInput(guild, userId, roles);
  return {
    guild,
    userId,
    input,
    isOwner: input.isOwner,
    perms: computePermissions(input),
    top: input.isOwner ? Infinity : Math.max(0, ...input.memberRoles.map((r) => r.position)),
  };
}

export type Access = Awaited<ReturnType<typeof requireMember>>;

/** The caller's bits in one channel (0 when they cannot see it). */
export const channelPermissions = (access: Access, overwrites: Overwrite[]) =>
  computePermissions({ ...access.input, overwrites });

export async function requireGuildPermission(guildId: string, userId: string, perm: number) {
  const access = await requireMember(guildId, userId);
  if (!hasPermission(access.perms, perm)) throw forbidden();
  return access;
}

/** Only for owner-only actions (delete guild, transfer ownership). */
export async function requireOwner(guildId: string, userId: string) {
  const access = await requireMember(guildId, userId);
  if (!access.isOwner) throw forbidden("Only the owner can do this");
  return access;
}

/**
 * Channel (with its overwrites), the caller's access and their bits in it. Unknown, malformed and foreign
 * ids and channels the caller cannot VIEW all give the same 404; a visible channel without `perm` gives 403.
 */
export async function requireChannelPermission(channelId: string, userId: string, perm: number = Permission.VIEW_CHANNEL) {
  const channel = isUuid(channelId)
    ? await prisma.channel.findUnique({ where: { id: channelId }, include: { overwrites: true } })
    : null;
  if (!channel) throw NOT_FOUND;
  const access = await requireMember(channel.guildId, userId);
  const perms = channelPermissions(access, channel.overwrites);
  if (!hasPermission(perms, Permission.VIEW_CHANNEL)) throw NOT_FOUND;
  if (!hasPermission(perms, perm)) throw forbidden();
  return { channel, access, perms };
}

/** Rule 2: a caller may only grant (or take away) bits they hold themselves. */
export function requireHeld(perms: number, bits: number) {
  if (bits & ~perms) throw forbidden("You cannot grant permissions you do not have");
}

/** Rule 1: a role of this guild strictly below the caller's top role (the owner passes). */
export async function requireRoleBelow(access: Access, roleId: string) {
  const role = isUuid(roleId) ? await prisma.role.findFirst({ where: { id: roleId, guildId: access.guild.id } }) : null;
  if (!role) throw NOT_FOUND;
  if (role.position >= access.top) throw forbidden("This role is not below your highest role");
  return role;
}

/**
 * Handing out (or taking away, or deleting) a role passes on everything it carries: its guild bits and its
 * overwrites. So the caller must hold all of those, each overwrite in its own channel.
 */
export async function requireHoldsRole(access: Access, role: Role) {
  requireHeld(access.perms, role.permissions);
  const overwrites = await prisma.channelOverwrite.findMany({
    where: { roleId: role.id },
    include: { channel: { include: { overwrites: true } } },
  });
  for (const o of overwrites) requireHeld(channelPermissions(access, o.channel.overwrites), o.allow | o.deny);
}

/**
 * Target of a kick or a role change: must be a member; the owner is off limits to everyone else; a non-owner
 * may only act on members strictly below their own top role (or on themselves, when `allowSelf`).
 */
export async function requireManageableMember(access: Access, userId: string, allowSelf: boolean) {
  const member = isUuid(userId)
    ? await prisma.member.findUnique({
        where: { guildId_userId: { guildId: access.guild.id, userId } },
        include: { roles: { select: { role: { select: { position: true } } } } },
      })
    : null;
  if (!member) throw NOT_FOUND;
  if (userId === access.userId) {
    if (allowSelf) return;
    throw new HttpError(400, "Not allowed on yourself");
  }
  if (userId === access.guild.ownerId) throw forbidden("The owner cannot be managed by others");
  const top = Math.max(0, ...member.roles.map((r) => r.role.position));
  if (top >= access.top) throw forbidden("This member is not below your highest role");
}

/** Every member's (or only `userIds`') bits in each of the guild's channels; 0 where they cannot VIEW it. */
export async function memberChannelPermissions(guildId: string, userIds?: string[]) {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    include: {
      roles: { where: { id: guildId } },
      channels: { include: { overwrites: true } },
      members: { where: userIds && { userId: { in: userIds } }, include: { roles: { include: { role: true } } } },
    },
  });
  if (!guild) return [];
  return guild.members.map((m) => {
    const input = permissionInput(guild, m.userId, [...guild.roles, ...m.roles.map((r) => r.role)]);
    return {
      userId: m.userId,
      perms: new Map(guild.channels.map((c) => [c.id, computePermissions({ ...input, overwrites: c.overwrites })])),
    };
  });
}

/** For each member (or only `userIds`), the guild's channels they cannot VIEW. */
export async function hiddenChannels(guildId: string, userIds?: string[]) {
  return (await memberChannelPermissions(guildId, userIds)).map(({ userId, perms }) => ({
    userId,
    channelIds: [...perms].filter(([, p]) => !hasPermission(p, Permission.VIEW_CHANNEL)).map(([id]) => id),
  }));
}
