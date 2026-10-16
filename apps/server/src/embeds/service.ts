import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { linkPreviewUrls } from "@loop/shared";
import { prisma } from "../db.js";
import type { Env } from "../env.js";
import { isUuid, NOT_FOUND } from "../guilds/access.js";
import { select, toDto } from "../messages/routes.js";
import { POLICIES } from "../rate-limits.js";
import type { ObjectStorage } from "../storage.js";
import { createFetcher, type Fetcher } from "./fetch.js";
import { thumbKey } from "./dto.js";
import { parsePreview } from "./parse.js";

declare module "fastify" {
  interface FastifyInstance {
    embeds: Embeds;
  }
}

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const CACHE_ENTRIES = 1000;
const FINAL_URL_MAX = 4096;
const PUBLIC_MAX_AGE = 300;

type Unfurled = { finalUrl: string | null; siteName: string | null; title: string | null; description: string | null; thumbHash: string | null };
const newHash = () => randomBytes(16).toString("hex");
const cacheKey = (url: string) => url.split("#")[0]!;

/** At most `concurrency` tasks run; up to `max` wait in line; beyond that a task is dropped (resolves undefined). */
function createQueue(concurrency: number, max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T | undefined> => {
    if (running < concurrency) running++;
    else if (waiting.length < max) await new Promise<void>((go) => waiting.push(go));
    else return undefined;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next(); // the slot passes straight on
      else running--;
    }
  };
}

/**
 * Link previews in the background: never part of a request, never throws into one, every failure silent.
 * ponytail: the cache, the queue and the per-user budget are per process (several instances each keep their own);
 * upgrade = Redis for the budget and a shared cache table if instances multiply.
 */
export function createEmbeds(app: FastifyInstance, env: Env) {
  const storage: ObjectStorage = app.storage;
  const fetcher: Fetcher = env.embedOverrides?.fetcher ?? createFetcher();
  const enqueue = createQueue(env.embedOverrides?.concurrency ?? 4, env.embedOverrides?.queueMax ?? 50);
  const budget = { ...POLICIES["link-preview"], ...env.rateLimitOverrides?.policies?.["link-preview"] };
  const spent = new Map<string, { count: number; resetAt: number }>();
  // Successes for 24 h, failures (null) for 10 min. Map order = least recently used first.
  const cache = new Map<string, { value: Unfurled | null; expires: number }>();
  const inflight = new Map<string, Promise<Unfurled | null | undefined>>();
  const jobs = new Set<Promise<void>>();

  const withinBudget = (userId: string) => {
    const now = Date.now();
    if (spent.size > 10_000) for (const [k, v] of spent) if (v.resetAt <= now) spent.delete(k);
    const s = spent.get(userId);
    if (!s || s.resetAt <= now) spent.set(userId, { count: 1, resetAt: now + budget.windowMs });
    else if (++s.count > budget.max) return false;
    return true;
  };

  const remember = (key: string, value: Unfurled | null) => {
    cache.delete(key);
    cache.set(key, { value, expires: Date.now() + (value ? SUCCESS_TTL_MS : FAILURE_TTL_MS) });
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  };

  /** The network part: page, preview, thumbnail (verified, stored under a fresh random key). */
  async function fetchPreview(url: string): Promise<Unfurled | null> {
    const page = await fetcher.page(url);
    const preview = page && parsePreview(page.html, page.url);
    if (!page || !preview) return null;
    let thumbHash: string | null = null;
    const image = preview.image && (await fetcher.image(preview.image));
    if (image) {
      const hash = newHash();
      if (await storage.put(thumbKey(hash), image.bytes, image.contentType).then(() => true, () => false)) thumbHash = hash;
    }
    const { siteName, title, description } = preview;
    return { finalUrl: page.url.length <= FINAL_URL_MAX ? page.url : null, siteName, title, description, thumbHash };
  }

  /** A preview that owns its thumbnail object: a cached one gets a copy (each embed row deletes its own). */
  async function own(value: Unfurled): Promise<Unfurled> {
    if (!value.thumbHash) return value;
    const head = await storage.head(thumbKey(value.thumbHash)).catch(() => null);
    const hash = newHash();
    const copied = head && (await storage.copy(thumbKey(value.thumbHash), thumbKey(hash), head.etag).catch(() => false));
    return { ...value, thumbHash: copied ? hash : null };
  }

  /** Cache, then an in-flight fetch of the same URL, then (budget and queue permitting) a new fetch. */
  async function unfurl(url: string, userId: string): Promise<Unfurled | null> {
    const key = cacheKey(url);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) {
      cache.delete(key); // most recently used goes last; the expiry stays
      cache.set(key, hit);
      return hit.value && own(hit.value);
    }
    const running = inflight.get(key);
    if (running) {
      const value = await running;
      return value ? own(value) : null;
    }
    if (!withinBudget(userId)) return null; // skipped, not cached: someone else may still preview it
    const task = enqueue(() => fetchPreview(url).catch(() => null));
    inflight.set(key, task);
    try {
      const value = await task;
      if (value !== undefined) remember(key, value); // undefined = dropped by a full queue: not a failure of the URL
      return value ?? null; // the first asker owns the fetched thumbnail itself
    } finally {
      inflight.delete(key);
    }
  }

  const removeThumbs = (hashes: (string | null)[]) => Promise.allSettled(hashes.filter((h): h is string => !!h).map((h) => storage.remove(thumbKey(h))));

  /** Tells whoever can see the message, as a normal update (current DM participants at this moment). */
  async function announce(messageId: string) {
    const row = await prisma.message.findUnique({ where: { id: messageId }, select });
    if (!row) return;
    const dto = await toDto(row, storage);
    if (row.channelId) return app.realtime.emit(row.channelId, "message:update", dto);
    const participants = await prisma.dmParticipant.findMany({ where: { dmChannelId: row.dmChannelId! }, select: { userId: true } });
    app.realtime.emitDm(participants.map((p) => p.userId), "update", dto);
  }

  /** Previews for the URLs of the message that have none yet; the rows are written only for URLs still in the text. */
  async function run(messageId: string, authorId: string) {
    const message = await prisma.message.findUnique({ where: { id: messageId }, select: { content: true, embeds: { select: { url: true } } } });
    if (!message) return;
    const have = new Set(message.embeds.map((e) => e.url));
    const wanted = linkPreviewUrls(message.content).filter((u) => !have.has(u));
    if (!wanted.length) return;
    const results = await Promise.all(wanted.map(async (url) => ({ url, value: await unfurl(url, authorId) })));
    const found = results.filter((r): r is { url: string; value: Unfurled } => !!r.value);
    if (!found.length) return;
    let inserted: string[] = [];
    try {
      inserted = await prisma.$transaction(async (tx) => {
        // the row lock orders this against an edit or a delete of the same message
        const [locked] = await tx.$queryRaw<{ content: string }[]>`SELECT "content" FROM "Message" WHERE "id" = ${messageId}::uuid FOR UPDATE`;
        if (!locked) return [];
        const now = linkPreviewUrls(locked.content);
        const taken = new Set((await tx.messageEmbed.findMany({ where: { messageId }, select: { url: true } })).map((e) => e.url));
        const rows = found.filter((r) => now.includes(r.url) && !taken.has(r.url));
        await tx.messageEmbed.createMany({ data: rows.map((r) => ({ messageId, url: r.url, position: now.indexOf(r.url), ...r.value })) });
        return rows.map((r) => r.url);
      });
    } finally {
      await removeThumbs(found.filter((r) => !inserted.includes(r.url)).map((r) => r.value.thumbHash)); // nobody points at these
    }
    if (inserted.length) await announce(messageId);
  }

  return {
    /** After a send or an edit: returns at once, the work happens later. No-op when LINK_PREVIEWS=off. */
    schedule(messageId: string, authorId: string) {
      if (!env.linkPreviews) return;
      const job = run(messageId, authorId).catch((e) => app.log.warn({ err: String((e as Error)?.message) }, "link preview failed"));
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
    },
    /** Tests: every scheduled job has finished. */
    idle: async () => {
      while (jobs.size) await Promise.all(jobs);
    },
    removeThumbs,
  };
}
export type Embeds = ReturnType<typeof createEmbeds>;

/**
 * Public like profile images (an <img> sends no token): the embed id is a random uuid that only the message JSON
 * reveals, so it follows the message's visibility; it says nothing else. Unknown, malformed, no thumbnail: one 404.
 */
export function embedRoutes(app: FastifyInstance) {
  app.get<{ Params: { embedId: string } }>("/embeds/:embedId/thumbnail", async (req, reply) => {
    const { embedId } = req.params;
    const embed = isUuid(embedId) ? await prisma.messageEmbed.findUnique({ where: { id: embedId }, select: { thumbHash: true } }) : null;
    if (!embed?.thumbHash) throw NOT_FOUND;
    const url = await app.storage.presignGet(thumbKey(embed.thumbHash), undefined, "inline");
    return reply.header("cache-control", `public, max-age=${PUBLIC_MAX_AGE}`).redirect(url, 302);
  });
}
