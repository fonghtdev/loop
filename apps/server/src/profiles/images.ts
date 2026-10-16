import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { IMAGE_MAX_BYTES, type ImageKind, imageCompleteSchema, imageUploadSchema, Permission } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { matchesType, SNIFF_BYTES } from "../attachments/rules.js";
import { isUuid, NOT_FOUND, requireGuildPermission } from "../guilds/access.js";
import { type ObjectStorage, UPLOAD_URL_SECONDS } from "../storage.js";

/** The presigned PUT lives 5 minutes; `complete` is refused after this, so a pending upload never becomes an image late. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const PUBLIC_MAX_AGE = 300;

export const pendingKey = (id: string) => `profile-uploads/${id}`;

export type Kind = {
  /** Public read route (unauthenticated: an <img> tag cannot send a bearer token). */
  readUrl: string;
  uploadUrl: string;
  /** Route-level permission to change the image of `req`'s target; returns the target's id (user or guild). */
  authorize: (req: FastifyRequest) => Promise<string>;
  /** Final key prefix; the full key is `<dir>/<kind>-<hash>`. */
  dir: (ownerId: string) => string;
  hashOf: (ownerId: string) => Promise<string | null | undefined>;
  setHash: (ownerId: string, hash: string | null) => Promise<unknown>;
  /** Tells everybody who shows this image; `change` = who changed it and whether it was removed (a guild icon's audit entry). */
  announce: (app: FastifyInstance, ownerId: string, change: { actorId: string; removed: boolean }) => Promise<unknown>;
};

export const imageKey = (dir: string, kind: ImageKind, hash: string) => `${dir}/${kind}-${hash}`;

export function imageRoutes(app: FastifyInstance, authed: FastifyInstance, kinds: Record<ImageKind, Kind>) {
  const { storage } = app;

  for (const [name, k] of Object.entries(kinds) as [ImageKind, Kind][]) {
    const keyOf = (ownerId: string, hash: string) => imageKey(k.dir(ownerId), name, hash);
    const removeOld = async (ownerId: string, hash: string | null | undefined) => {
      if (hash) await storage.remove(keyOf(ownerId, hash)).catch(() => {}); // best effort; the object is unreachable anyway
    };

    /** Step 1: remember what is announced and hand out a PUT URL. A new request replaces the caller's older pending one. */
    authed.post(`${k.uploadUrl}/upload`, async (req, reply) => {
      const ownerId = await k.authorize(req);
      const body = parse(imageUploadSchema, req.body, reply);
      if (!body) return;
      if (body.size > IMAGE_MAX_BYTES[name]) throw new HttpError(400, "Image too large");
      const guildId = name === "icon" ? ownerId : null;
      const older = await prisma.profileUpload.findMany({ where: { userId: req.userId, kind: name, guildId }, select: { id: true } });
      await prisma.profileUpload.deleteMany({ where: { id: { in: older.map((u) => u.id) } } });
      await Promise.allSettled(older.map((u) => storage.remove(pendingKey(u.id))));
      const id = randomUUID();
      await prisma.profileUpload.create({ data: { id, userId: req.userId, kind: name, guildId, contentType: body.contentType, size: body.size } });
      const uploadUrl = await storage.presignPut(pendingKey(id), body.contentType, body.size);
      return reply.code(201).send({ id, uploadUrl, expiresInSeconds: UPLOAD_URL_SECONDS, headers: { "Content-Type": body.contentType } });
    });

    /** Step 3: look at what was really stored; only then does it become the image. Any failure leaves nothing behind. */
    authed.post(`${k.uploadUrl}/complete`, async (req, reply) => {
      const ownerId = await k.authorize(req);
      const body = parse(imageCompleteSchema, req.body, reply);
      if (!body) return;
      const upload = isUuid(body.id)
        ? await prisma.profileUpload.findFirst({ where: { id: body.id, userId: req.userId, kind: name, guildId: name === "icon" ? ownerId : null } })
        : null;
      if (!upload) throw NOT_FOUND;
      // claiming the row first makes a second (parallel) complete a 404
      if (!(await prisma.profileUpload.deleteMany({ where: { id: upload.id } })).count) throw NOT_FOUND;
      const fail = async (message: string): Promise<never> => {
        await storage.remove(pendingKey(upload.id)).catch(() => {});
        throw new HttpError(400, message);
      };
      if (Date.now() - upload.createdAt.getTime() > PENDING_TTL_MS) return fail("Upload expired");
      const head = await storage.head(pendingKey(upload.id));
      if (!head) return fail("Upload not found");
      if (head.size !== upload.size || head.size > IMAGE_MAX_BYTES[name]) return fail("Uploaded size does not match");
      // every step is pinned to the checked ETag: an overwrite in between makes the read or the copy fail
      const bytes = await storage.firstBytes(pendingKey(upload.id), Math.min(head.size, SNIFF_BYTES), head.etag);
      if (!bytes) return fail("Upload changed during verification");
      if (!matchesType(upload.contentType, bytes)) return fail("File content does not match its type");
      const hash = randomBytes(6).toString("hex");
      if (!(await storage.copy(pendingKey(upload.id), keyOf(ownerId, hash), head.etag))) return fail("Upload changed during verification");
      await storage.remove(pendingKey(upload.id)).catch(() => {});
      const previous = await k.hashOf(ownerId);
      await k.setHash(ownerId, hash);
      await removeOld(ownerId, previous);
      await k.announce(app, ownerId, { actorId: req.userId, removed: false });
      return reply.send({ hash });
    });

    authed.delete(k.uploadUrl, async (req, reply) => {
      const ownerId = await k.authorize(req);
      const previous = await k.hashOf(ownerId);
      await k.setHash(ownerId, null);
      await removeOld(ownerId, previous);
      if (previous) await k.announce(app, ownerId, { actorId: req.userId, removed: true });
      return reply.code(204).send();
    });

    /** Unauthenticated and uniform: a malformed id, an unknown owner and "no image" all give the same 404. */
    app.get<{ Params: Record<string, string> }>(k.readUrl, async (req, reply: FastifyReply) => {
      const ownerId = Object.values(req.params)[0]!;
      const hash = isUuid(ownerId) ? await k.hashOf(ownerId) : null;
      if (!hash) throw NOT_FOUND;
      const url = await storage.presignGet(keyOf(ownerId, hash), undefined, "inline");
      return reply.header("cache-control", `public, max-age=${PUBLIC_MAX_AGE}`).redirect(url, 302);
    });
  }
}

/** The caller changes an image of a guild they own or administer. */
export const requireGuildAdmin = async (req: FastifyRequest) =>
  (await requireGuildPermission((req.params as { guildId: string }).guildId, req.userId, Permission.ADMINISTRATOR)).guild.id;

/**
 * Deletes pending uploads older than `cutoff` (default 24 hours; `complete` already refuses them after 10 minutes)
 * together with their objects. Returns how many were removed.
 */
export async function sweepStaleProfileUploads(storage: ObjectStorage, cutoff = new Date(Date.now() - STALE_AFTER_MS)) {
  const stale = await prisma.profileUpload.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: 500 });
  const { count } = await prisma.profileUpload.deleteMany({ where: { id: { in: stale.map((u) => u.id) } } });
  await Promise.allSettled(stale.map((u) => storage.remove(pendingKey(u.id))));
  return count;
}
