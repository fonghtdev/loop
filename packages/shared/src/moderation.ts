import { z } from "zod";
import { optionalText, SINGLE_LINE } from "./profiles.js";

/** How far back a ban may delete the banned user's messages in the guild (hours; 0 = keep everything). */
export const BAN_DELETE_HOURS = [0, 1, 24, 168] as const;

/** PUT /guilds/:guildId/bans/:userId. The reason is shown to moderators only (never to the banned user). */
export const banSchema = z
  .object({
    reason: optionalText(200, SINGLE_LINE).nullish().transform((r) => r ?? null),
    deleteMessageHours: z.union([z.literal(0), z.literal(1), z.literal(24), z.literal(168)]).default(0),
  })
  .strict();

/** PUT /guilds/:guildId/roles/order: every role but @everyone, highest first. */
export const roleOrderSchema = z
  .object({ roleIds: z.array(z.string().uuid()).max(250) })
  .strict()
  .refine((b) => new Set(b.roleIds).size === b.roleIds.length, "duplicate role id");

export type BanDto = {
  user: { id: string; username: string; displayName: string | null; avatarHash: string | null };
  reason: string | null;
  bannedBy: { id: string; username: string } | null; // null once the moderator's account is gone
  createdAt: string;
};

export type InviteDto = {
  code: string;
  createdBy: { id: string; username: string };
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
};

/** Realtime `roles:updated` to every member: the guild's roles changed order; refetch GET /guilds/:id/roles. */
export type RolesUpdatedEvent = { guildId: string };
