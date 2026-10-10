import type { Prisma } from "@prisma/client";
import { Permission } from "@loop/shared";
import { HttpError } from "../http.js";
import { isUuid, requireChannelPermission } from "../guilds/access.js";
import { requireDm, requireFriendsUnblocked } from "../social/access.js";

type Target = { channelId: string | null; dmChannelId: string | null };

/**
 * Uploading to (or completing an upload for) a conversation needs exactly what sending a message there needs:
 * channel = VIEW + SEND_MESSAGES on a text channel, DM = participant + friends and not blocked.
 */
export async function requireCanSend(userId: string, target: Target) {
  if (target.channelId) {
    const { channel } = await requireChannelPermission(target.channelId, userId, Permission.SEND_MESSAGES);
    if (channel.type !== "TEXT") throw new HttpError(400, "Only text channels accept messages");
  } else {
    const { otherId } = await requireDm(target.dmChannelId!, userId);
    await requireFriendsUnblocked(userId, otherId);
  }
}

/**
 * Attaches the sender's own READY, still unattached uploads of THIS conversation to a message, inside the
 * message's transaction. One conditional UPDATE does the check and the claim, so two messages racing for
 * one attachment cannot both win. Unknown, foreign, pending, used, malformed and wrong-conversation ids all
 * give the same 400 (another user's id cannot be told apart from a missing one).
 */
export async function claimAttachments(
  tx: Prisma.TransactionClient,
  ids: string[],
  userId: string,
  target: { channelId: string } | { dmChannelId: string },
  messageId: string,
) {
  if (!ids.length) return;
  const { count } = ids.every(isUuid)
    ? await tx.attachment.updateMany({
        where: { id: { in: ids }, uploaderId: userId, status: "READY", messageId: null, ...target },
        data: { messageId },
      })
    : { count: 0 };
  if (count !== ids.length) throw new HttpError(400, "Invalid attachments");
}
