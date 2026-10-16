import { z } from "zod";

/** Names of things are copied into the entry (the thing itself may be gone later); never message content or secrets. */
const name = z.string().max(100);
const bits = z.number().int().min(0);
const none = z.object({}).strict();
const named = z.object({ name }).strict();
const voice = z.object({ channel: name }).strict();

/**
 * Every audit action and the exact shape of its `meta`. The part before the dot is the action's group (the
 * `action` filter of GET .../audit-log takes a whole action or a group). Targets: `targetUserId` is the member acted
 * on; `targetId` is the role / channel / thread / AutoMod rule id (see the server's call sites).
 */
export const AUDIT_META = {
  "member.kick": none,
  "member.ban": z.object({ reason: z.string().max(200).nullable(), deleteMessageHours: z.number().int(), deletedMessages: z.number().int() }).strict(),
  "member.unban": none,
  "role.create": z.object({ name, permissions: bits }).strict(),
  "role.update": z.object({ name, changed: z.array(z.enum(["name", "permissions", "color"])) }).strict(),
  "role.delete": named,
  "role.assign": named,
  "role.unassign": named,
  "role.reorder": none,
  "channel.create": z.object({ name, type: z.enum(["TEXT", "VOICE"]) }).strict(),
  "channel.update": z.object({ name, changed: z.array(z.enum(["name", "topic"])) }).strict(),
  "channel.delete": named,
  "channel.category_create": named,
  "channel.category_update": named,
  "channel.category_delete": named,
  "channel.layout_update": none,
  // role overwrite: `role` is its name; member overwrite: `role` null and the member in targetUserId
  "channel.overwrite_set": z.object({ channel: name, role: name.nullable(), allow: bits, deny: bits }).strict(),
  "channel.overwrite_delete": z.object({ channel: name, role: name.nullable() }).strict(),
  // the code itself is never stored: a live invite code is a key to the server
  "invite.create": z.object({ maxUses: z.number().int().nullable(), expiresInSeconds: z.number().int().nullable() }).strict(),
  "invite.revoke": none, // targetUserId = who made the invite
  "guild.update": named,
  "guild.icon": z.object({ removed: z.boolean() }).strict(),
  "guild.transfer": none,
  "voice.mute": voice,
  "voice.unmute": voice,
  "voice.deafen": voice,
  "voice.undeafen": voice,
  "voice.move": voice, // the destination
  "message.delete": none, // a moderator deleted someone else's message: targetUserId = author, targetId = channel
  "message.thread_delete": named, // a moderator (not its creator) deleted a thread
  "automod.rule_create": named,
  "automod.rule_update": z.object({ name, changed: z.array(z.enum(["name", "enabled", "keywords"])) }).strict(),
  "automod.rule_delete": named,
  "automod.block": z.object({ rule: name, channelId: z.string().uuid() }).strict(), // targetId = rule id
} as const;

export type AuditAction = keyof typeof AUDIT_META;
export type AuditMeta<A extends AuditAction> = z.infer<(typeof AUDIT_META)[A]>;
export const AUDIT_ACTIONS = Object.keys(AUDIT_META) as AuditAction[];
export const AUDIT_GROUPS = [...new Set(AUDIT_ACTIONS.map((a) => a.split(".")[0]!))];
export const MAX_AUDIT_META_BYTES = 1024;
export const AUDIT_RETENTION_DAYS = 90;

/** GET /guilds/:guildId/audit-log: `action` is an action or a group (`member`, `role`, ...); `before` = an entry id. */
export const auditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    before: z.string().uuid().optional(),
    action: z.string().regex(/^[a-z]+(\.[a-z_]+)?$/).max(40).optional(),
    actorId: z.string().uuid().optional(),
  })
  .strict();

export type AuditUser = { id: string; username: string; displayName: string | null; avatarHash: string | null };
/** `action` may be one this client does not know (a newer server): show it generically. */
export type AuditEntryDto = {
  id: string;
  action: string;
  actor: AuditUser | null; // null once the account is gone
  targetUser: AuditUser | null;
  targetId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
};
export type AuditPage = { entries: AuditEntryDto[]; hasMore: boolean };
