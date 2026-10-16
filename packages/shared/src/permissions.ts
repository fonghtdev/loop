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
  CONNECT: 1 << 8, // join a voice channel (DM calls are decided by friendship, not by this bit)
  SPEAK: 1 << 9, // publish the microphone
  VIDEO: 1 << 10, // publish the camera
  STREAM: 1 << 11, // share the screen
  MOVE_MEMBERS: 1 << 12, // move someone to another voice channel (needs it in both channels); not in @everyone
  MENTION_EVERYONE: 1 << 13, // write @everyone / @here so it counts as a mention of all; not in @everyone
  BAN_MEMBERS: 1 << 14, // ban / unban and list bans; guild-wide (not in overwrites), not in @everyone
  VIEW_AUDIT_LOG: 1 << 15, // read the guild's audit log; guild-wide (not in overwrites), not in @everyone
  MUTE_MEMBERS: 1 << 16, // server-mute someone in a voice channel; channel-overwritable, not in @everyone
  DEAFEN_MEMBERS: 1 << 17, // server-deafen someone in a voice channel; channel-overwritable, not in @everyone
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((all, bit) => all | bit, 0);

export const DEFAULT_EVERYONE_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.CREATE_INVITE |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.VIDEO |
  Permission.STREAM;

/** The only bits a channel overwrite may allow or deny; the others are guild-wide. */
export const CHANNEL_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.MANAGE_MESSAGES |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.VIDEO |
  Permission.STREAM |
  Permission.MOVE_MEMBERS |
  Permission.MENTION_EVERYONE |
  Permission.MUTE_MEMBERS |
  Permission.DEAFEN_MEMBERS;

type RolePerms = { id: string; permissions: number };
export type Overwrite = { roleId: string; allow: number; deny: number };
/** A channel overwrite for one member (same bits and rules as a role's). */
export type MemberOverwrite = { userId: string; allow: number; deny: number };

export type PermissionInput = {
  isOwner: boolean;
  everyoneRole: RolePerms;
  /** The member's roles, without @everyone. */
  memberRoles: RolePerms[];
  /** The channel's overwrites (any roles; foreign ones are ignored). Omit for guild-wide permissions. */
  overwrites?: Overwrite[];
  /** The member these permissions are for: picks their entry in `memberOverwrites`. */
  userId?: string;
  /** The channel's member overwrites (anyone's; only `userId`'s applies). Only read when `overwrites` is given. */
  memberOverwrites?: MemberOverwrite[];
};

/**
 * The usual (Discord) algorithm with channel overwrites:
 * 1. owner -> everything; 2. base = @everyone | every member role; ADMINISTRATOR in base -> everything;
 * 3. channel: apply the @everyone overwrite (deny, then allow); then OR the deny of all the member's role
 *    overwrites and the allow of all of them, apply the denies, then the allows (so any role's allow beats
 *    any role's deny, and both beat @everyone's overwrite); then the member's own overwrite (deny, then allow),
 *    which beats every role;
 * 4. without VIEW_CHANNEL in a channel the member has no permission there at all.
 */
export function computePermissions({ isOwner, everyoneRole, memberRoles, overwrites, userId, memberOverwrites }: PermissionInput) {
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
  const mine = userId === undefined ? undefined : memberOverwrites?.find((o) => o.userId === userId);
  if (mine) perms = (perms & ~mine.deny) | mine.allow;
  return perms & Permission.VIEW_CHANNEL ? perms : 0;
}

export const hasPermission = (perms: number, perm: number) => (perms & perm) === perm;

export const can = (input: PermissionInput, perm: number) => hasPermission(computePermissions(input), perm);
