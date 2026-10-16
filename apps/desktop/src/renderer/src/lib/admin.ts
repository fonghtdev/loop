import { ALL_PERMISSIONS, banSchema, CHANNEL_PERMISSIONS, channelTopicSchema, computePermissions, hasPermission, type MemberOverwrite, Permission, updateGuildSchema, type Overwrite, type PermissionName } from "@loop/shared";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { normalize } from "./quick-switch";
import { channelNameError } from "./validation";
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
export type SettingsTab = "overview" | "roles" | "members" | "bans" | "invites" | "overwrites" | "automod" | "audit" | "danger";
const ADMIN_BITS = Permission.ADMINISTRATOR | Permission.MANAGE_ROLES | Permission.KICK_MEMBERS | Permission.MANAGE_CHANNELS | Permission.BAN_MEMBERS | Permission.VIEW_AUDIT_LOG;

/** The settings sections the user may open, in tab order; empty = no entry at all (a plain member). */
export function settingsSections(bits: number, isOwner: boolean): SettingsTab[] {
  if (!isOwner && !(bits & ADMIN_BITS)) return [];
  const manageRoles = hasPermission(bits, Permission.MANAGE_ROLES);
  const overview = isOwner || hasPermission(bits, Permission.ADMINISTRATOR); // the server's own identity: renaming and the icon need ADMINISTRATOR
  const bans = hasPermission(bits, Permission.BAN_MEMBERS);
  // server: MANAGE_ROLES lists every invite, CREATE_INVITE only one's own
  const invites = manageRoles || hasPermission(bits, Permission.CREATE_INVITE);
  const audit = hasPermission(bits, Permission.VIEW_AUDIT_LOG); // ADMINISTRATOR and the owner hold every bit
  // AutoMod has no bit of its own: the server lets the owner and ADMINISTRATOR manage it (the same test as `overview`)
  const sections: (SettingsTab | false)[] = [overview && "overview", manageRoles && "roles", "members", bans && "bans", invites && "invites", manageRoles && "overwrites", overview && "automod", audit && "audit", isOwner && "danger"];
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

/** Ban: BAN_MEMBERS plus the kick hierarchy (ADMINISTRATOR passes the bit, never the hierarchy). */
export const canBan = (s: Standing, target: Member, ownerId: string, roles: Role[]) =>
  hasPermission(s.bits, Permission.BAN_MEMBERS) && canManageMember(s, target, ownerId, roles, "kick");

/** Choices for how much of a banned member's recent history goes (server: `deleteMessageHours` 0 | 1 | 24 | 168). */
export const BAN_DELETE_OPTIONS: { hours: number; label: MessageKey }[] = [
  { hours: 0, label: "ban.delete.none" },
  { hours: 1, label: "ban.delete.hour" },
  { hours: 24, label: "ban.delete.day" },
  { hours: 168, label: "ban.delete.week" },
];
/** The reason field against the server's own schema (at most 200 characters, one line, no control characters). */
export const banReasonError = (reason: string) =>
  banSchema.safeParse({ reason }).success ? undefined : t([...reason.trim()].length > 200 ? "validation.banReasonLong" : "profile.errors.chars");

/** A member's channel overwrite: MANAGE_ROLES checked by the caller; the target strictly below them, never the owner or oneself. */
export const canSetMemberOverwrite = (s: Standing, target: Member, ownerId: string, roles: Role[]) => canManageMember(s, target, ownerId, roles, "kick");

/** Members whose name or username contains `query` (accents and case ignored), by name. */
export function filterMembers(members: Member[], query: string, nameOf: (m: Member) => string) {
  const q = normalize(query);
  return members.filter((m) => !q || normalize(nameOf(m)).includes(q) || normalize(m.username).includes(q)).sort((a, b) => nameOf(a).localeCompare(nameOf(b), "vi"));
}

// ---- role order (server: PUT /guilds/:id/roles/order) ----
/** Every role but @everyone, highest first: the body the server wants. */
export const roleOrder = (roles: Role[], guildId: string) =>
  roles.filter((r) => r.id !== guildId).sort((a, b) => b.position - a.position || a.id.localeCompare(b.id)).map((r) => r.id);

/**
 * The server's rule for a non-owner: the roles at or above their top open the list in their current order (so nothing
 * moves to or above them); when two of those share a position only the owner may reorder at all.
 */
export function orderAllowed(s: Standing, roles: Role[], guildId: string, order: string[]) {
  if (s.isOwner) return true;
  const fixed = roles.filter((r) => r.id !== guildId && r.position >= s.top).sort((a, b) => b.position - a.position);
  if (new Set(fixed.map((r) => r.position)).size !== fixed.length) return false;
  return fixed.every((r, i) => order[i] === r.id);
}

/** Drag and drop: `id` placed before / after `targetId`. null when nothing changes or the server would refuse it. */
export function dropRole(s: Standing, roles: Role[], guildId: string, order: string[], id: string, targetId: string, where: "before" | "after") {
  if (id === targetId || !order.includes(id) || !order.includes(targetId)) return null;
  const rest = order.filter((x) => x !== id);
  const at = rest.indexOf(targetId) + (where === "after" ? 1 : 0);
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  if (next.every((x, i) => x === order[i])) return null;
  return orderAllowed(s, roles, guildId, next) ? next : null;
}

/** The up (-1) / down (+1) buttons: one step past the neighbour, through `dropRole`'s rules. */
export function shiftRole(s: Standing, roles: Role[], guildId: string, order: string[], id: string, delta: -1 | 1) {
  const neighbour = order[order.indexOf(id) + delta];
  return order.includes(id) && neighbour ? dropRole(s, roles, guildId, order, id, neighbour, delta < 0 ? "before" : "after") : null;
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
      { name: "MENTION_EVERYONE", label: "perm.MENTION_EVERYONE", desc: "perm.MENTION_EVERYONE.desc" },
    ],
  },
  {
    title: "perm.group.management",
    items: [
      { name: "MANAGE_CHANNELS", label: "perm.MANAGE_CHANNELS", desc: "perm.MANAGE_CHANNELS.desc" },
      { name: "MANAGE_ROLES", label: "perm.MANAGE_ROLES", desc: "perm.MANAGE_ROLES.desc" },
      { name: "KICK_MEMBERS", label: "perm.KICK_MEMBERS", desc: "perm.KICK_MEMBERS.desc" },
      { name: "BAN_MEMBERS", label: "perm.BAN_MEMBERS", desc: "perm.BAN_MEMBERS.desc" },
      { name: "VIEW_AUDIT_LOG", label: "perm.VIEW_AUDIT_LOG", desc: "perm.VIEW_AUDIT_LOG.desc" },
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
      { name: "MOVE_MEMBERS", label: "perm.MOVE_MEMBERS", desc: "perm.MOVE_MEMBERS.desc" },
      { name: "MUTE_MEMBERS", label: "perm.MUTE_MEMBERS", desc: "perm.MUTE_MEMBERS.desc" },
      { name: "DEAFEN_MEMBERS", label: "perm.DEAFEN_MEMBERS", desc: "perm.DEAFEN_MEMBERS.desc" },
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

/** What `member` would get in the channel once their own overwrite is `draft` (their real roles, every other overwrite as is). */
export function previewMemberPermissions(roles: Role[], everyoneId: string, member: Member, channel: { overwrites: Overwrite[]; memberOverwrites?: MemberOverwrite[] }, draft: Pair) {
  return computePermissions({
    isOwner: false, // the owner is never a target
    everyoneRole: roles.find((r) => r.id === everyoneId) ?? { id: everyoneId, permissions: 0 },
    memberRoles: roles.filter((r) => r.id !== everyoneId && member.roleIds.includes(r.id)),
    overwrites: channel.overwrites,
    userId: member.userId,
    memberOverwrites: [...(channel.memberOverwrites ?? []).filter((o) => o.userId !== member.userId), { userId: member.userId, ...draft }],
  });
}

/** Deleting a server needs its exact name typed. */
export const nameMatches = (typed: string, name: string) => typed.trim() === name;

/** The caller's own bits in one of the guild's channels (the same function the server runs). */
export const callerChannelBits = (ctx: SettingsCtx, channel: Pick<Channel, "overwrites" | "memberOverwrites">) =>
  permissionsFor(
    { userId: ctx.standing.userId, guild: { id: ctx.guildId, name: ctx.guildName, ownerId: ctx.ownerId, createdAt: "" }, roles: ctx.roles, members: ctx.members },
    channel,
  );

// ---- server and channel identity ----
/** Server name rules of the server's own schema (1..100 after trimming). */
export const guildNameError = (name: string) => (updateGuildSchema.safeParse({ name }).success ? undefined : t(name.trim() === "" ? "validation.required" : "validation.guildNameLong"));

const topicChars = (s: string) => [...s.trim()].length;
/** Topic rules of the server's schema (at most 1024 characters, no control or bidi characters; empty = no topic). */
export const topicError = (topic: string) => (channelTopicSchema.safeParse(topic).success ? undefined : t(topicChars(topic) > 1024 ? "validation.topicLong" : "profile.errors.chars"));

/** Only what changed in the channel edit form (a cleared topic is null); null when nothing changed. */
export function channelPatch(channel: Pick<Channel, "name" | "topic">, draft: { name: string; topic: string }) {
  const patch: { name?: string; topic?: string | null } = {};
  if (draft.name !== channel.name) patch.name = draft.name;
  const topic = draft.topic.trim() || null;
  if (topic !== (channel.topic ?? null)) patch.topic = topic;
  return Object.keys(patch).length ? patch : null;
}

/** The channel edit form is valid: the name follows the creation rules, the topic its schema. */
export const channelEditError = (draft: { name: string; topic: string }) => ({ name: channelNameError(draft.name), topic: topicError(draft.topic) });
