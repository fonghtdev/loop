import { ALL_PERMISSIONS, CHANNEL_PERMISSIONS, computePermissions, hasPermission, Permission, type Overwrite, type PermissionName } from "@loop/shared";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { permissionsFor, type Channel, type Member, type PermissionData, type Role } from "./permissions";

/*
 * Server administration helpers. Everything here only HIDES or DISABLES UI: the rules mirror the server's
 * (guilds/access.ts, CLAUDE.md step 5) but the server stays the authority and every action handles its 403/404.
 */

/** The caller's standing in a guild: bits, and `top` = highest role position (owner outranks every role). */
export type Standing = { userId: string; isOwner: boolean; bits: number; top: number };

/** Highest position among the member's roles (0 = only @everyone). */
export const topPosition = (roleIds: string[], roles: Pick<Role, "id" | "position">[]) =>
  Math.max(0, ...roles.filter((r) => roleIds.includes(r.id)).map((r) => r.position));

export function standingFor(data: PermissionData): Standing | null {
  const me = data.members.find((m) => m.userId === data.userId);
  if (!me) return null;
  const isOwner = data.guild.ownerId === data.userId;
  return { userId: data.userId, isOwner, bits: permissionsFor(data), top: isOwner ? Infinity : topPosition(me.roleIds, data.roles) };
}

/** Everything a settings panel works from (loaded and permission-checked by ServerSettings). */
export type SettingsCtx = { guildId: string; guildName: string; ownerId: string; standing: Standing; roles: Role[]; members: Member[]; channels: Channel[] };

// ---- gating ----
export type SettingsTab = "roles" | "members" | "overwrites" | "danger";
const ADMIN_BITS = Permission.ADMINISTRATOR | Permission.MANAGE_ROLES | Permission.KICK_MEMBERS | Permission.MANAGE_CHANNELS;

/** The settings sections the user may open, in tab order; empty = no entry at all (a plain member). */
export function settingsSections(bits: number, isOwner: boolean): SettingsTab[] {
  if (!isOwner && !(bits & ADMIN_BITS)) return [];
  const manageRoles = hasPermission(bits, Permission.MANAGE_ROLES);
  const sections: (SettingsTab | false)[] = [manageRoles && "roles", "members", manageRoles && "overwrites", isOwner && "danger"];
  return sections.filter((s): s is SettingsTab => !!s);
}

/** A stored or open settings tab re-checked against what the user may open now (restore, ownership change). */
export function guardSettings(tab: SettingsTab | null, sections: SettingsTab[]): SettingsTab | null {
  if (tab === null || sections.length === 0) return null;
  return sections.includes(tab) ? tab : sections[0];
}

// ---- hierarchy (server rules 1-4) ----
/** Rule 1: a role strictly below the caller's top (the owner passes; ADMINISTRATOR does not bypass). */
export const canManageRole = (s: Standing, role: Pick<Role, "position">) => s.isOwner || role.position < s.top;

/** Kick (rule 3) and role assignment: not the owner, not yourself for a kick, target strictly below the caller. */
export function canManageMember(s: Standing, target: Member, ownerId: string, roles: Role[], action: "kick" | "roles") {
  if (target.userId === s.userId) return action === "roles";
  if (target.userId === ownerId) return false;
  return s.isOwner || topPosition(target.roleIds, roles) < s.top;
}

/** Rule 2: only bits the caller holds (in `scope`) can be granted or taken away. */
export const grantableBits = (bits: number, scope: number = ALL_PERMISSIONS) => bits & scope;

/**
 * Rule 2b: handing out a role passes on its bits and its overwrites, so the caller must hold them all
 * (each overwrite in its own channel: `channels` pairs a channel's overwrites with the caller's bits there).
 */
export function canHandOutRole(s: Standing, role: Role, channels: { overwrites: Overwrite[]; bits: number }[]) {
  if (role.id === role.guildId || !canManageRole(s, role) || role.permissions & ~s.bits) return false;
  return channels.every((c) => c.overwrites.every((o) => o.roleId !== role.id || ((o.allow | o.deny) & ~c.bits) === 0));
}

// ---- role editing ----
export const roleNameError = (name: string) => {
  const n = name.trim();
  if (!n) return t("validation.required");
  if (n.length > 100) return t("validation.roleNameLong");
  if (n === "@everyone") return t("validation.roleNameReserved");
  return undefined;
};

/** Only what changed (and never the name of @everyone); null when there is nothing to save. Unknown bits ride along in `permissions`. */
export function patchRole(role: Role, draft: { name: string; permissions: number; color: string | null }) {
  const patch: { name?: string; permissions?: number; color?: string | null } = {};
  const name = draft.name.trim();
  if (role.id !== role.guildId && name !== role.name) patch.name = name;
  if (draft.permissions !== role.permissions) patch.permissions = draft.permissions;
  if (draft.color !== (role.color ?? null)) patch.color = draft.color;
  return Object.keys(patch).length ? patch : null;
}

export const setBit = (perms: number, bit: number, on: boolean) => (on ? perms | bit : perms & ~bit);
export const unknownBits = (perms: number) => perms & ~ALL_PERMISSIONS;

// ---- permission labels (one entry per Permission; a test fails when a bit has none) ----
type Info = { name: PermissionName; label: MessageKey; desc: MessageKey };
export const PERMISSION_GROUPS: { title: MessageKey; items: Info[] }[] = [
  {
    title: "perm.group.general",
    items: [
      { name: "VIEW_CHANNEL", label: "perm.VIEW_CHANNEL", desc: "perm.VIEW_CHANNEL.desc" },
      { name: "CREATE_INVITE", label: "perm.CREATE_INVITE", desc: "perm.CREATE_INVITE.desc" },
    ],
  },
  {
    title: "perm.group.messages",
    items: [
      { name: "SEND_MESSAGES", label: "perm.SEND_MESSAGES", desc: "perm.SEND_MESSAGES.desc" },
      { name: "MANAGE_MESSAGES", label: "perm.MANAGE_MESSAGES", desc: "perm.MANAGE_MESSAGES.desc" },
    ],
  },
  {
    title: "perm.group.management",
    items: [
      { name: "MANAGE_CHANNELS", label: "perm.MANAGE_CHANNELS", desc: "perm.MANAGE_CHANNELS.desc" },
      { name: "MANAGE_ROLES", label: "perm.MANAGE_ROLES", desc: "perm.MANAGE_ROLES.desc" },
      { name: "KICK_MEMBERS", label: "perm.KICK_MEMBERS", desc: "perm.KICK_MEMBERS.desc" },
      { name: "ADMINISTRATOR", label: "perm.ADMINISTRATOR", desc: "perm.ADMINISTRATOR.desc" },
    ],
  },
  {
    title: "perm.group.voice",
    items: [
      { name: "CONNECT", label: "perm.CONNECT", desc: "perm.CONNECT.desc" },
      { name: "SPEAK", label: "perm.SPEAK", desc: "perm.SPEAK.desc" },
      { name: "VIDEO", label: "perm.VIDEO", desc: "perm.VIDEO.desc" },
      { name: "STREAM", label: "perm.STREAM", desc: "perm.STREAM.desc" },
    ],
  },
];

/** The bits a channel overwrite may touch, with their labels. */
export const CHANNEL_BITS = PERMISSION_GROUPS.flatMap((g) => g.items).filter((i) => Permission[i.name] & CHANNEL_PERMISSIONS);

// ---- channel overwrites ----
export type Tri = "allow" | "inherit" | "deny";
type Pair = { allow: number; deny: number };

export const triOf = (o: Pair, bit: number): Tri => (o.deny & bit ? "deny" : o.allow & bit ? "allow" : "inherit");

/** Sets one bit's state; the bit leaves the other side, so it is never both allowed and denied. */
export function setTri(o: Pair, bit: number, tri: Tri): Pair {
  const allow = o.allow & ~bit;
  const deny = o.deny & ~bit;
  return { allow: tri === "allow" ? allow | bit : allow, deny: tri === "deny" ? deny | bit : deny };
}

/** What a member holding only `roleId` (plus @everyone) would get in the channel once `draft` is saved. */
export function previewPermissions(roles: Role[], everyoneId: string, roleId: string, overwrites: Overwrite[], draft: Pair) {
  const role = roles.find((r) => r.id === roleId);
  return computePermissions({
    isOwner: false,
    everyoneRole: roles.find((r) => r.id === everyoneId) ?? { id: everyoneId, permissions: 0 },
    memberRoles: role && roleId !== everyoneId ? [role] : [],
    overwrites: [...overwrites.filter((o) => o.roleId !== roleId), { roleId, ...draft }],
  });
}

/** Deleting a server needs its exact name typed. */
export const nameMatches = (typed: string, name: string) => typed.trim() === name;

/** The caller's own bits in one of the guild's channels (the same function the server runs). */
export const callerChannelBits = (ctx: SettingsCtx, channel: Pick<Channel, "overwrites">) =>
  permissionsFor(
    { userId: ctx.standing.userId, guild: { id: ctx.guildId, name: ctx.guildName, ownerId: ctx.ownerId, createdAt: "" }, roles: ctx.roles, members: ctx.members },
    channel,
  );
