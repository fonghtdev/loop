import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createAttachmentSchema, MAX_ATTACHMENT_BYTES } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { isUuid, NOT_FOUND, requireChannelPermission } from "../guilds/access.js";
import { requireDm } from "../social/access.js";
import { UPLOAD_URL_SECONDS } from "../storage.js";
import { requireCanSend } from "./access.js";
import { attachmentDto, attachmentSelect } from "./dto.js";
import { finalKey, matchesType, MAX_PENDING_PER_USER, SNIFF_BYTES, uploadKey } from "./rules.js";
import { removeObjects } from "./sweep.js";

export function attachmentRoutes(app: FastifyInstance) {
  const { storage } = app;

  /** The upload is rejected: its object and row go, so a bad upload leaves nothing behind. */
  const discard = async (a: { id: string }, reason: string): Promise<never> => {
    await removeObjects(storage, [a.id]);
    await prisma.attachment.deleteMany({ where: { id: a.id } });
    throw new HttpError(400, reason);
  };

  /** Step 1: reserve a row and hand out a PUT URL. Nothing is trusted until `complete`. */
  app.post("/attachments", async (req, reply) => {
    const body = parse(createAttachmentSchema, req.body, reply);
    if (!body) return;
    const target = { channelId: body.channelId ?? null, dmChannelId: body.dmChannelId ?? null };
    await requireCanSend(req.userId, target);
    // ponytail: count-then-insert, so parallel requests can overshoot the cap slightly; the sweep clears the rest
    if ((await prisma.attachment.count({ where: { uploaderId: req.userId, status: "PENDING" } })) >= MAX_PENDING_PER_USER)
      throw new HttpError(429, "Too many pending uploads");
    const id = randomUUID();
    await prisma.attachment.create({
      data: {
        id,
        uploaderId: req.userId,
        ...target,
        objectKey: uploadKey(id), // server-made: no part of it comes from the request
        filename: body.filename,
        contentType: body.contentType,
        size: body.size,
      },
    });
    const uploadUrl = await storage.presignPut(uploadKey(id), body.contentType, body.size);
    return reply.code(201).send({
      id,
      uploadUrl,
      expiresInSeconds: UPLOAD_URL_SECONDS,
      headers: { "Content-Type": body.contentType },
    });
  });

  /** Step 3: look at what was really stored; only then does the attachment become usable. */
  app.post<{ Params: { id: string } }>("/attachments/:id/complete", async (req) => {
    const a = isUuid(req.params.id)
      ? await prisma.attachment.findFirst({ where: { id: req.params.id, uploaderId: req.userId } })
      : null;
    if (!a) throw NOT_FOUND;
    await requireCanSend(req.userId, a);
    if (a.status === "READY") return attachmentDto(a, storage);
    const head = await storage.head(uploadKey(a.id));
    if (!head) return discard(a, "Upload not found");
    if (head.size !== a.size || head.size > MAX_ATTACHMENT_BYTES) return discard(a, "Uploaded size does not match");
    // Every step is pinned to the ETag that was checked: an overwrite in between makes the read or the copy fail.
    const bytes = await storage.firstBytes(uploadKey(a.id), Math.min(head.size, SNIFF_BYTES), head.etag);
    if (!bytes) return discard(a, "Upload changed during verification");
    if (!matchesType(a.contentType, bytes)) return discard(a, "File content does not match its type");
    if (!(await storage.copy(uploadKey(a.id), finalKey(a.id), head.etag))) return discard(a, "Upload changed during verification");
    const ready = { ...a, objectKey: finalKey(a.id) };
    await prisma.attachment.updateMany({ where: { id: a.id }, data: { status: "READY", objectKey: ready.objectKey } });
    await storage.remove(uploadKey(a.id)).catch(() => {}); // best effort; the sweep and message delete also clear it
    return attachmentDto(ready, storage);
  });

  /**
   * Fresh download URL. The uploader sees their own unattached uploads; once attached, the caller must be
   * able to read the message's conversation (VIEW / participant). Everything else is the same 404.
   */
  app.get<{ Params: { id: string } }>("/attachments/:id", async (req) => {
    const a = isUuid(req.params.id)
      ? await prisma.attachment.findUnique({
          where: { id: req.params.id },
          select: { ...attachmentSelect, uploaderId: true, messageId: true, message: { select: { channelId: true, dmChannelId: true } } },
        })
      : null;
    if (!a) throw NOT_FOUND;
    if (!a.message) {
      if (a.uploaderId !== req.userId) throw NOT_FOUND;
    } else if (a.message.channelId) await requireChannelPermission(a.message.channelId, req.userId);
    else await requireDm(a.message.dmChannelId!, req.userId);
    return attachmentDto(a, storage);
  });
}
