import type { AuditAction, AuditEntryDto, AuditUser } from "@loop/shared";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";

/** The filter's groups (the part of an action before the dot); "" = everything. The server filters by group. */
export const AUDIT_FILTERS: { group: string; label: MessageKey }[] = [
  { group: "", label: "audit.group.all" },
  { group: "member", label: "audit.group.member" },
  { group: "role", label: "audit.group.role" },
  { group: "channel", label: "audit.group.channel" },
  { group: "invite", label: "audit.group.invite" },
  { group: "guild", label: "audit.group.guild" },
  { group: "voice", label: "audit.group.voice" },
  { group: "message", label: "audit.group.message" },
  { group: "automod", label: "audit.group.automod" },
];

export const AUDIT_PAGE = 25;
/** GET .../audit-log query for one page: filters left empty are left out; `before` = the last entry already shown. */
export function auditQuery({ group, actorId, before }: { group: string; actorId: string; before?: string }) {
  const q = new URLSearchParams({ limit: String(AUDIT_PAGE) });
  if (group) q.set("action", group);
  if (actorId) q.set("actorId", actorId);
  if (before) q.set("before", before);
  return q.toString();
}

/** Every action this client knows, with its sentence. A test fails when an action of @loop/shared has none. */
export const SENTENCES: Record<AuditAction, MessageKey> = {
  "member.kick": "audit.member.kick",
  "member.ban": "audit.member.ban",
  "member.unban": "audit.member.unban",
  "role.create": "audit.role.create",
  "role.update": "audit.role.update",
  "role.delete": "audit.role.delete",
  "role.assign": "audit.role.assign",
  "role.unassign": "audit.role.unassign",
  "role.reorder": "audit.role.reorder",
  "channel.create": "audit.channel.create",
  "channel.update": "audit.channel.update",
  "channel.delete": "audit.channel.delete",
  "channel.category_create": "audit.channel.category_create",
  "channel.category_update": "audit.channel.category_update",
  "channel.category_delete": "audit.channel.category_delete",
  "channel.layout_update": "audit.channel.layout_update",
  "channel.overwrite_set": "audit.channel.overwrite_set",
  "channel.overwrite_delete": "audit.channel.overwrite_delete",
  "invite.create": "audit.invite.create",
  "invite.revoke": "audit.invite.revoke",
  "guild.update": "audit.guild.update",
  "guild.icon": "audit.guild.icon",
  "guild.transfer": "audit.guild.transfer",
  "voice.mute": "audit.voice.mute",
  "voice.unmute": "audit.voice.unmute",
  "voice.deafen": "audit.voice.deafen",
  "voice.undeafen": "audit.voice.undeafen",
  "voice.move": "audit.voice.move",
  "message.delete": "audit.message.delete",
  "message.thread_delete": "audit.message.thread_delete",
  "automod.rule_create": "audit.automod.rule_create",
  "automod.rule_update": "audit.automod.rule_update",
  "automod.rule_delete": "audit.automod.rule_delete",
  "automod.block": "audit.automod.block",
};
/** Variants picked by the entry's meta (a member overwrite has no role; a removed icon). */
const MEMBER_OVERWRITE: Partial<Record<AuditAction, MessageKey>> = { "channel.overwrite_set": "audit.channel.overwrite_set_member", "channel.overwrite_delete": "audit.channel.overwrite_delete_member" };
const FIELDS: Record<string, MessageKey> = {
  name: "audit.field.name",
  permissions: "audit.field.permissions",
  color: "audit.field.color",
  topic: "audit.field.topic",
  enabled: "audit.field.enabled",
  keywords: "audit.field.keywords",
};

type Lookup = {
  /** How a person is shown (display name, else username). */
  nameOf: (u: AuditUser) => string;
  /** A channel of this server by id (the entry stores ids for things that still exist), undefined when unknown. */
  channelName: (id: string) => string | undefined;
};
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * One readable Vietnamese sentence per entry, plus an optional detail line (ban reason, what changed). Text only,
 * never HTML. An action this client does not know (a newer server) gets a generic sentence that names it.
 */
export function auditSentence(e: AuditEntryDto, { nameOf, channelName }: Lookup): { text: string; detail: string | null } {
  const action = e.action as AuditAction;
  const meta = e.meta ?? {};
  const actor = e.actor ? nameOf(e.actor) : e.action === "automod.block" ? t("audit.automod") : t("audit.deletedUser");
  const target = e.targetUser ? nameOf(e.targetUser) : t("audit.deletedUser");
  const channel = str(meta.channel) || (e.targetId && channelName(e.targetId)) || (typeof meta.channelId === "string" && channelName(meta.channelId)) || t("audit.someChannel");
  const vars = { actor, target, name: str(meta.name) || str(meta.rule), channel, role: str(meta.role) };
  let key = SENTENCES[action];
  if (!key) return { text: t("audit.unknown", { actor, action: e.action }), detail: null };
  if (MEMBER_OVERWRITE[action] && meta.role === null) key = MEMBER_OVERWRITE[action]!;
  if (action === "guild.icon" && meta.removed === true) key = "audit.guild.icon_removed";
  return { text: t(key, vars), detail: detailOf(action, meta) };
}

function detailOf(action: AuditAction, meta: Record<string, unknown>): string | null {
  if (action === "member.ban") {
    const parts = [meta.reason ? t("bans.reason", { reason: str(meta.reason) }) : t("bans.noReason")];
    if (typeof meta.deletedMessages === "number" && meta.deletedMessages > 0) parts.push(t("audit.detail.deleted", { count: String(meta.deletedMessages) }));
    return parts.join(" · ");
  }
  if (Array.isArray(meta.changed) && meta.changed.length) {
    return t("audit.detail.changed", { fields: meta.changed.map((f) => (FIELDS[f as string] ? t(FIELDS[f as string]!) : String(f))).join(", ") });
  }
  return null;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];
const relative = new Intl.RelativeTimeFormat("vi", { numeric: "auto" });
/** "5 phút trước", "hôm qua"...; under a minute "vừa xong". The exact time goes in the tooltip (`exactTime`). */
export function relativeTime(iso: string, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  for (const [unit, size] of UNITS) if (Math.abs(ms) >= size) return relative.format(Math.round(ms / size), unit);
  return t("audit.justNow");
}
export const exactTime = (iso: string) => new Date(iso).toLocaleString("vi-VN");

/** The people who appear as actors in the loaded entries (for the actor filter), by name; the chosen one stays listed. */
export function actorChoices(entries: AuditEntryDto[], members: AuditUser[], nameOf: (u: AuditUser) => string) {
  const byId = new Map<string, AuditUser>(members.map((m) => [m.id, m]));
  for (const e of entries) if (e.actor) byId.set(e.actor.id, e.actor);
  return [...byId.values()].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "vi"));
}
