import type { Prisma } from "@prisma/client";
import { HttpError } from "../http.js";
import { isUuid, requireWritableChannel } from "../guilds/access.js";
import { requireDmWritable } from "../social/access.js";

type Target = { channelId: string | null; dmChannelId: string | null };

/**
 * Uploading to (or completing an upload for) a conversation needs exactly what sending a message there needs:
 * channel = VIEW + SEND_MESSAGES on a text channel or an open thread, DM = participant (+ friends and not blocked for a pair).
 */
export async function requireCanSend(userId: string, target: Target) {
  if (target.channelId) {
    await requireWritableChannel(target.channelId, userId);
  } else {
    await requireDmWritable(target.dmChannelId!, userId);
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
