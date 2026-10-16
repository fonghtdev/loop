import { hasEveryoneMention, hasPermission, mentionIds, Permission } from "@loop/shared";
import { memberChannelPermissions } from "../guilds/access.js";

export type Mentions = { userIds: string[]; everyone: boolean };
/** Where a message is written: who can be mentioned depends on it. */
export type MentionScope =
  | { guildId: string; channelId: string; canEveryone: boolean }
  | { dmParticipantIds: string[] };

export const noMentions: Mentions = { userIds: [], everyone: false };

/**
 * What the text really mentions: `<@id>` tokens of people who may read the message (guild members with VIEW on
 * the channel, or the DM's current participants; the rest stay inert text), and @everyone / @here only when the author
 * holds MENTION_EVERYONE (never in a DM).
 */
export async function resolveMentions(content: string, scope: MentionScope): Promise<Mentions> {
  const ids = mentionIds(content);
  if ("dmParticipantIds" in scope) return { userIds: ids.filter((id) => scope.dmParticipantIds.includes(id)), everyone: false };
  const everyone = scope.canEveryone && hasEveryoneMention(content);
  if (!ids.length) return { userIds: [], everyone };
  const members = await memberChannelPermissions(scope.guildId, ids);
  const readers = new Set(members.filter((m) => hasPermission(m.perms.get(scope.channelId) ?? 0, Permission.VIEW_CHANNEL)).map((m) => m.userId));
  return { userIds: ids.filter((id) => readers.has(id)), everyone };
}

export const canMentionEveryone = (perms: number) => hasPermission(perms, Permission.MENTION_EVERYONE);

/**
 * Who gets a `mention:new` push (their `user:<id>` room, so it arrives even for a channel they have not opened): the
 * mentioned people, or every member who can VIEW the channel for @everyone / @here; never the author.
 */
export async function mentionRecipients(channel: { id: string; guildId: string }, mentions: Mentions, authorId: string) {
  if (!mentions.everyone) return mentions.userIds.filter((id) => id !== authorId);
  const members = await memberChannelPermissions(channel.guildId);
  return members.filter((m) => m.userId !== authorId && hasPermission(m.perms.get(channel.id) ?? 0, Permission.VIEW_CHANNEL)).map((m) => m.userId);
}
