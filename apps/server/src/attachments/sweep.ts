import { prisma } from "../db.js";
import type { ObjectStorage } from "../storage.js";
import { finalKey, STALE_AFTER_MS, uploadKey } from "./rules.js";

/** Both keys of each attachment (a re-PUT can leave an upload key behind). Best effort: never fails the caller. */
export async function removeObjects(storage: ObjectStorage, ids: string[]) {
  await Promise.allSettled(ids.flatMap((id) => [uploadKey(id), finalKey(id)]).map((k) => storage.remove(k)));
}

/**
 * Deletes uploads that never became part of a message: still PENDING, or READY but never attached, and
 * created before `cutoff` (default: 24 hours ago). Returns how many were removed.
 * ponytail: objects whose row was cascade-deleted (guild, channel or DM deleted) are not found here because
 * the row is gone; upgrade = a bucket lifecycle rule on `uploads/` or a deletion queue. Batches of 500 per run.
 */
export async function sweepStaleAttachments(storage: ObjectStorage, cutoff = new Date(Date.now() - STALE_AFTER_MS)) {
  const stale = await prisma.attachment.findMany({
    where: { createdAt: { lt: cutoff }, messageId: null },
    select: { id: true },
    take: 500,
  });
  let removed = 0;
  for (const a of stale) {
    // row first, conditional: an attachment claimed in the meantime keeps both row and object
    const { count } = await prisma.attachment.deleteMany({ where: { id: a.id, messageId: null } });
    if (count) {
      removed++;
      await removeObjects(storage, [a.id]);
    }
  }
  return removed;
}
