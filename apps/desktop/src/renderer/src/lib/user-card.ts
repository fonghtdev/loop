import { hasPermission, Permission } from "@loop/shared";
import { createStore } from "zustand/vanilla";
import { canHandOutRole, canManageMember, callerChannelBits, type SettingsCtx } from "./admin";
import type { Member, Role } from "./permissions";
import type { Dm, FriendsData } from "./social";

// ---- what the card is open on ----
export type CardTarget = { userId: string; username: string; guildId: string | null; anchor: HTMLElement };

/** The one open card (null = closed). The host component in the shell renders it; any name or avatar can open it. */
export const userCard = createStore<{ target: CardTarget | null }>(() => ({ target: null }));
export const openUserCard = (target: CardTarget) => userCard.setState({ target });
export const closeUserCard = () => userCard.setState({ target: null });

// ---- placement ----
export type Box = { left: number; top: number; width: number; height: number };

/**
 * Where the card goes: under the anchor with its left edges aligned, flipped above when the bottom would overflow, then
 * clamped inside the viewport (margin each side) so it never leaves the window, wherever the anchor is.
 */
export function placeCard(anchor: Box, card: { width: number; height: number }, view: { width: number; height: number }, gap = 8, margin = 8) {
  const clamp = (v: number, size: number, max: number) => Math.max(margin, Math.min(v, max - margin - size));
  const below = anchor.top + anchor.height + gap;
  const fitsBelow = below + card.height <= view.height - margin;
  const top = fitsBelow ? below : anchor.top - gap - card.height;
  return { left: clamp(anchor.left, card.width, view.width), top: clamp(top, card.height, view.height) };
}

// ---- who the person is to me ----
export type Relation = "none" | "friend" | "incoming" | "outgoing";

export function relationOf(userId: string, friends: FriendsData | undefined): Relation {
  if (friends?.friends.some((f) => f.id === userId)) return "friend";
  if (friends?.incoming.some((u) => u.id === userId)) return "incoming";
  if (friends?.outgoing.some((u) => u.id === userId)) return "outgoing";
  return "none";
}

/** Presence exists only for friends and DM partners (the server tracks no one else): undefined = not known, show nothing. */
export const presenceOf = (userId: string, friends: FriendsData | undefined, dms: Dm[] | undefined) =>
  (friends?.friends.find((f) => f.id === userId) ?? dms?.find((d) => d.user.id === userId)?.user)?.online;

export type CardActions = {
  /** "open": a DM already exists; "create": a friend without one (POST /dms needs a friendship). */
  message: "open" | "create" | null;
  friend: "add" | "cancel" | "accept" | "unfriend" | null;
  block: "block" | "unblock" | null;
};
const NONE: CardActions = { message: null, friend: null, block: null };

/**
 * The buttons of the card, by server rules: yourself gets none; a bot has no friends and no DMs (but can be blocked);
 * a blocked person can only be unblocked (requests and DMs to them are refused); a DM needs a friendship or an existing DM.
 */
export function cardActions(i: { selfId: string; userId: string; isBot: boolean; relation: Relation; blocked: boolean; hasDm: boolean }): CardActions {
  if (i.userId === i.selfId) return NONE;
  if (i.blocked) return { ...NONE, block: "unblock" };
  if (i.isBot) return { ...NONE, block: "block" };
  const friend = { none: "add", friend: "unfriend", incoming: "accept", outgoing: "cancel" } as const;
  const message = i.hasDm ? "open" : i.relation === "friend" ? "create" : null;
  return { message, friend: friend[i.relation], block: "block" };
}

// ---- dates and roles ----
const dateFormat = new Intl.DateTimeFormat("vi-VN", { day: "numeric", month: "long", year: "numeric" });

/** "5 tháng 3, 2026"-style date for the card; "" for a missing or invalid value. */
export function cardDate(iso: string | undefined) {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? dateFormat.format(at) : "";
}

/** The member's real roles for the chips: never @everyone (id = guild id), highest position first (like the roles list). */
export function roleChips(roleIds: string[], roles: Role[], guildId: string) {
  return roles.filter((r) => r.id !== guildId && roleIds.includes(r.id)).sort((a, b) => b.position - a.position);
}

/** Dot color of a role: its own `color` when the server sends one, else a stable pick from the palette by role id. */
const ROLE_PALETTE = ["#e5736b", "#e8a05a", "#e3c65c", "#8fcf6a", "#4fc9a4", "#55b9e0", "#6f93f0", "#a78bfa", "#d77bd8", "#f08aa9"];
export function roleColor(role: Pick<Role, "id" | "color">) {
  if (role.color) return role.color;
  let h = 0;
  for (const ch of role.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ROLE_PALETTE[h % ROLE_PALETTE.length];
}

/** The picker list: roles whose name contains the query (case-insensitive, trimmed); an empty query keeps all. */
export function filterRoles(roles: Role[], query: string) {
  const q = query.trim().toLowerCase();
  return roles.filter((r) => r.name.toLowerCase().includes(q));
}

/** Arrow-key step through `length` rows, wrapping at both ends; -1 when the list is empty. */
export const stepIndex = (index: number, delta: 1 | -1, length: number) => (length === 0 ? -1 : (index + delta + length) % length);

/**
 * What the roles block of the card shows. The owner has no roles block (a crown by the name instead). "+" depends only on
 * the right to manage this member's roles, NOT on what is left to hand out (an empty picker says so itself). Without that
 * right the chips are read-only, and the block is hidden when there is nothing to show.
 */
export function rolesView(i: { isOwner: boolean; chipCount: number; mod: ModView | null }) {
  if (i.isOwner) return { show: false, canAdd: false };
  const canAdd = i.mod?.canRoles ?? false;
  return { show: canAdd || i.chipCount > 0, canAdd };
}

export type ModView = { kick: boolean; canRoles: boolean; assignable: Role[]; removable: Set<string> };

/**
 * What an admin may do to this member from the card, from the SAME rules as the members panel (`canManageMember`, rule
 * 2b `canHandOutRole`): a role can be added or removed only when the caller may hand it out; @everyone never.
 */
export function modView(ctx: SettingsCtx, target: Member): ModView {
  const { standing, ownerId, roles, guildId } = ctx;
  const channels = ctx.channels.map((c) => ({ overwrites: c.overwrites, bits: callerChannelBits(ctx, c) }));
  const mayRoles = hasPermission(standing.bits, Permission.MANAGE_ROLES) && canManageMember(standing, target, ownerId, roles, "roles");
  const handOut = (r: Role) => r.id !== guildId && canHandOutRole(standing, r, channels);
  const usable = mayRoles ? roles.filter(handOut) : [];
  return {
    canRoles: mayRoles,
    kick: hasPermission(standing.bits, Permission.KICK_MEMBERS) && canManageMember(standing, target, ownerId, roles, "kick"),
    assignable: usable.filter((r) => !target.roleIds.includes(r.id)).sort((a, b) => b.position - a.position),
    removable: new Set(usable.filter((r) => target.roleIds.includes(r.id)).map((r) => r.id)),
  };
}
