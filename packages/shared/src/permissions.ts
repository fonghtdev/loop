/** Permission bits, stored as an Int bitmask on roles and channel overwrites. */
export const Permission = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  MANAGE_MESSAGES: 1 << 2, // delete other people's messages
  MANAGE_CHANNELS: 1 << 3, // create/delete channels
  CREATE_INVITE: 1 << 4,
  MANAGE_ROLES: 1 << 5, // roles, role assignment, channel overwrites
  KICK_MEMBERS: 1 << 6,
  ADMINISTRATOR: 1 << 7, // passes every permission check (not the role hierarchy)
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((all, bit) => all | bit, 0);

export const DEFAULT_EVERYONE_PERMISSIONS =
  Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.CREATE_INVITE;

/** The only bits a channel overwrite may allow or deny; the others are guild-wide. */
export const CHANNEL_PERMISSIONS = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.MANAGE_MESSAGES;

type RolePerms = { id: string; permissions: number };
export type Overwrite = { roleId: string; allow: number; deny: number };

export type PermissionInput = {
  isOwner: boolean;
  everyoneRole: RolePerms;
  /** The member's roles, without @everyone. */
  memberRoles: RolePerms[];
  /** The channel's overwrites (any roles; foreign ones are ignored). Omit for guild-wide permissions. */
  overwrites?: Overwrite[];
};

/**
 * Discord's algorithm (minus member-specific overwrites):
 * 1. owner -> everything; 2. base = @everyone | every member role; ADMINISTRATOR in base -> everything;
 * 3. channel: apply the @everyone overwrite (deny, then allow); then OR the deny of all the member's role
 *    overwrites and the allow of all of them, apply the denies, then the allows (so any role's allow beats
 *    any role's deny, and both beat @everyone's overwrite);
 * 4. without VIEW_CHANNEL in a channel the member has no permission there at all.
 */
export function computePermissions({ isOwner, everyoneRole, memberRoles, overwrites }: PermissionInput) {
  if (isOwner) return ALL_PERMISSIONS;
  let perms = memberRoles.reduce((p, r) => p | r.permissions, everyoneRole.permissions);
  if (perms & Permission.ADMINISTRATOR) return ALL_PERMISSIONS;
  if (!overwrites) return perms;

  const everyone = overwrites.find((o) => o.roleId === everyoneRole.id);
  if (everyone) perms = (perms & ~everyone.deny) | everyone.allow;
  const roleIds = new Set(memberRoles.map((r) => r.id));
  let allow = 0;
  let deny = 0;
  for (const o of overwrites) {
    if (!roleIds.has(o.roleId)) continue;
    allow |= o.allow;
    deny |= o.deny;
  }
  perms = (perms & ~deny) | allow;
  return perms & Permission.VIEW_CHANNEL ? perms : 0;
}

export const hasPermission = (perms: number, perm: number) => (perms & perm) === perm;

export const can = (input: PermissionInput, perm: number) => hasPermission(computePermissions(input), perm);
