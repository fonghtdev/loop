import type { Prisma } from "@prisma/client";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { AUDIT_META, AUDIT_RETENTION_DAYS, type AuditAction, type AuditEntryDto, type AuditMeta, auditQuerySchema, MAX_AUDIT_META_BYTES, Permission } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { requireGuildPermission } from "./access.js";

declare module "fastify" {
  interface FastifyInstance {
    audit: Audit;
  }
}

type Db = Prisma.TransactionClient | typeof prisma;
export type AuditRow = Prisma.AuditLogUncheckedCreateInput;
/** Test seam (`env.auditWriter`): replaces the insert, e.g. with one that fails. */
export type AuditWriter = (db: Db, row: AuditRow) => Promise<unknown>;
const insert: AuditWriter = (db, row) => db.auditLog.create({ data: row });

type Options<A extends AuditAction> = {
  targetUserId?: string | null;
  targetId?: string | null;
  /** The change's own transaction: the entry commits (or rolls back) with it, and a failure fails the change. */
  tx?: Prisma.TransactionClient;
} & ({} extends AuditMeta<A> ? { meta?: AuditMeta<A> } : { meta: AuditMeta<A> });

const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCK_ENTRY_EVERY_MS = 60 * 1000;

/**
 * THE way an audit entry is written, from every moderation / admin mutation. `meta` must match AUDIT_META for the
 * action and stay under 1 KB (a bug otherwise: logged, nothing written). Outside a transaction a failed write is
 * logged and swallowed: the change it describes already happened and must not be reported as failed.
 */
export function createAudit(log: FastifyBaseLogger, write: AuditWriter = insert) {
  async function audit<A extends AuditAction>(guildId: string, actorId: string | null, action: A, opts: Options<A>) {
    const meta = AUDIT_META[action].safeParse(opts.meta ?? {});
    if (!meta.success || Buffer.byteLength(JSON.stringify(meta.data)) > MAX_AUDIT_META_BYTES) {
      log.error({ action }, "audit entry has a bad meta; not written");
      return;
    }
    const row: AuditRow = { guildId, actorId, action, targetUserId: opts.targetUserId ?? null, targetId: opts.targetId ?? null, metadata: meta.data };
    if (opts.tx) {
      await write(opts.tx, row);
      return;
    }
    try {
      await write(prisma, row);
    } catch (e) {
      log.error({ err: String((e as Error)?.message), action }, "audit entry failed");
    }
  }

  /**
   * An AutoMod block, at most one entry per (user, rule) per minute so spam cannot flood the log.
   * ponytail: check-then-insert, two blocks racing in the same instant may both be written; a Redis SET NX if it matters.
   */
  async function block(guildId: string, userId: string, rule: { id: string; name: string }, channelId: string) {
    try {
      const recent = await prisma.auditLog.count({
        where: { guildId, action: "automod.block", targetUserId: userId, targetId: rule.id, createdAt: { gt: new Date(Date.now() - BLOCK_ENTRY_EVERY_MS) } },
      });
      if (!recent) await audit(guildId, null, "automod.block", { targetUserId: userId, targetId: rule.id, meta: { rule: rule.name, channelId } });
    } catch (e) {
      log.error({ err: String((e as Error)?.message) }, "audit entry failed");
    }
  }

  return Object.assign(audit, { block });
}
export type Audit = ReturnType<typeof createAudit>;

/** Retention: entries older than 90 days go (server.ts runs it hourly; tests pass a cutoff). Returns how many. */
export async function sweepAuditLog(cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * DAY_MS)) {
  return (await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } })).count;
}

const userSelect = { id: true, username: true, displayName: true, avatarHash: true } as const;

export function auditRoutes(app: FastifyInstance) {
  /** Newest first, paged by `before` (an entry id of this guild). VIEW_AUDIT_LOG (owner / ADMINISTRATOR pass); non-member 404. */
  app.get<{ Params: { guildId: string } }>("/guilds/:guildId/audit-log", async (req, reply) => {
    const { guild } = await requireGuildPermission(req.params.guildId, req.userId, Permission.VIEW_AUDIT_LOG);
    const q = parse(auditQuerySchema, req.query, reply);
    if (!q) return;
    const cursor = q.before ? await prisma.auditLog.findFirst({ where: { id: q.before, guildId: guild.id }, select: { id: true, createdAt: true } }) : null;
    if (q.before && !cursor) throw new HttpError(400, "Unknown cursor");
    const rows = await prisma.auditLog.findMany({
      where: {
        guildId: guild.id,
        ...(q.actorId && { actorId: q.actorId }),
        ...(q.action && (q.action.includes(".") ? { action: q.action } : { action: { startsWith: `${q.action}.` } })),
        ...(cursor && { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      include: { actor: { select: userSelect }, targetUser: { select: userSelect } },
    });
    const entries = rows.slice(0, q.limit).map(
      (r): AuditEntryDto => ({
        id: r.id,
        action: r.action,
        actor: r.actor,
        targetUser: r.targetUser,
        targetId: r.targetId,
        meta: r.metadata as Record<string, unknown>,
        createdAt: r.createdAt.toISOString(),
      }),
    );
    return { entries, hasMore: rows.length > q.limit };
  });
}
