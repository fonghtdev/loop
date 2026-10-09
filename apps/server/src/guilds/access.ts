import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError } from "../http.js";

export const NOT_FOUND = new HttpError(404, "Not found");
export const isUuid = (id: string) => z.string().uuid().safeParse(id).success;

/**
 * Every guild-scoped route goes through these lookups (step 5 swaps them for `can(member, channel, perm)`).
 * Non-members get 404, never 403, so a guild's existence does not leak.
 */
export async function requireMember(guildId: string, userId: string) {
  const guild = isUuid(guildId)
    ? await prisma.guild.findFirst({ where: { id: guildId, members: { some: { userId } } } })
    : null;
  if (!guild) throw NOT_FOUND;
  return guild;
}

export async function requireOwner(guildId: string, userId: string) {
  const guild = await requireMember(guildId, userId);
  if (guild.ownerId !== userId) throw new HttpError(403, "Only the owner can do this");
  return guild;
}

/** Channel + its guild, only if `userId` is a member of that guild. Unknown, malformed and foreign ids all give 404. */
export async function requireChannelMember(channelId: string, userId: string) {
  const channel = isUuid(channelId)
    ? await prisma.channel.findFirst({
        where: { id: channelId, guild: { members: { some: { userId } } } },
        include: { guild: true },
      })
    : null;
  if (!channel) throw NOT_FOUND;
  return channel;
}
