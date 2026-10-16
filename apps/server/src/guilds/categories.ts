import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { categoryNameSchema, hasPermission, layoutSchema, Permission } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { bitsInChannel, isUuid, NOT_FOUND, permissionSource, requireGuildPermission } from "./access.js";
import { lockGuild } from "./routes.js";

type Params = { guildId: string; categoryId: string };
type Tx = Prisma.TransactionClient;
type Placement = { id: string; categoryId: string | null; position: number };

const NAME_TAKEN = new HttpError(409, "Category name already taken");
const LAYOUT_CHANGED = new HttpError(409, "Layout changed, reload and try again");
const manageChannels = (guildId: string, userId: string) => requireGuildPermission(guildId, userId, Permission.MANAGE_CHANNELS);
const isNameTaken = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Stable order inside one area: position, then age, then id (positions are not unique). */
const byPlacement = (a: { position: number; createdAt: Date; id: string }, b: { position: number; createdAt: Date; id: string }) =>
  a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/** Moves the category's channels, in their old order, to the end of the uncategorised area, then deletes it. */
async function removeCategory(tx: Tx, guildId: string, categoryId: string): Promise<Placement[]> {
  if (!(await tx.category.findFirst({ where: { id: categoryId, guildId } }))) throw NOT_FOUND;
  const moved = (await tx.channel.findMany({ where: { guildId, categoryId } })).sort(byPlacement);
  const last = await tx.channel.aggregate({ where: { guildId, categoryId: null }, _max: { position: true } });
  const start = (last._max.position ?? -1) + 1;
  const placements = moved.map((c, i) => ({ id: c.id, categoryId: null, position: start + i }));
  for (const p of placements) await tx.channel.update({ where: { id: p.id }, data: { categoryId: null, position: p.position } });
  await tx.category.delete({ where: { id: categoryId } });
  return placements;
}

/**
 * Applies a complete layout. The caller's list must be exactly the guild's categories and the channels the
 * caller can see (else 409, or 400 when it names an id that exists but is not theirs to list). Channels the
 * caller cannot see keep their category and relative order and sit after the visible ones of that category.
 */
async function applyLayout(tx: Tx, guildId: string, layout: ReturnType<typeof layoutSchema.parse>, canView: (channel: Parameters<typeof bitsInChannel>[1]) => boolean) {
  await lockGuild(tx, guildId);
  const [categories, channels] = await Promise.all([
    tx.category.findMany({ where: { guildId } }),
    tx.channel.findMany({ where: { guildId, parentChannelId: null }, include: permissionSource }), // threads have no place in the layout
  ]);
  const visible = channels.filter((c) => canView(c));
  const hidden = channels.filter((c) => !canView(c));
  const sameSet = (given: string[], expected: string[]) => given.length === expected.length && given.every((id) => expected.includes(id));
  const channelIds = visible.map((c) => c.id);
  const categoryIds = categories.map((c) => c.id);
  const given = [...layout.channels.map((c) => c.id), ...layout.categories];
  if (!sameSet(layout.channels.map((c) => c.id), channelIds) || !sameSet(layout.categories, categoryIds)) {
    const unlisted = given.filter((id) => !channelIds.includes(id) && !categoryIds.includes(id));
    const known = unlisted.length
      ? (await tx.channel.count({ where: { id: { in: unlisted } } })) + (await tx.category.count({ where: { id: { in: unlisted } } }))
      : 0;
    // an id that exists but is foreign (or hidden) is a bad request; ids that are simply gone mean a stale list
    throw known ? new HttpError(400, "Layout contains ids that do not belong to this guild") : LAYOUT_CHANGED;
  }

  const hiddenOrder = hidden.sort(byPlacement);
  const next = new Map<string | null, string[]>();
  for (const c of layout.channels) next.set(c.categoryId, [...(next.get(c.categoryId) ?? []), c.id]);
  for (const c of hiddenOrder) next.set(c.categoryId, [...(next.get(c.categoryId) ?? []), c.id]);

  const placements: Placement[] = [...next].flatMap(([categoryId, ids]) => ids.map((id, position) => ({ id, categoryId, position })));
  const before = new Map(channels.map((c) => [c.id, c]));
  for (const p of placements) {
    const old = before.get(p.id)!;
    if (old.categoryId !== p.categoryId || old.position !== p.position) await tx.channel.update({ where: { id: p.id }, data: { categoryId: p.categoryId, position: p.position } });
  }
  const categoryPlacements = layout.categories.map((id, position) => ({ id, position }));
  for (const c of categoryPlacements) {
    if (categories.find((x) => x.id === c.id)!.position !== c.position) await tx.category.update({ where: { id: c.id }, data: { position: c.position } });
  }
  return { categories: categoryPlacements, channels: placements, hidden: new Set(hidden.map((c) => c.id)) };
}

export function categoryRoutes(app: FastifyInstance) {
  app.post<{ Params: Params }>("/guilds/:guildId/categories", async (req, reply) => {
    const { guild } = await manageChannels(req.params.guildId, req.userId);
    const body = parse(categoryNameSchema, req.body, reply);
    if (!body) return;
    try {
      const category = await prisma.$transaction(async (tx) => {
        await lockGuild(tx, guild.id);
        const last = await tx.category.aggregate({ where: { guildId: guild.id }, _max: { position: true } });
        const created = await tx.category.create({ data: { guildId: guild.id, name: body.name, position: (last._max.position ?? -1) + 1 } });
        await app.audit(guild.id, req.userId, "channel.category_create", { targetId: created.id, meta: { name: created.name }, tx });
        return created;
      });
      await app.realtime.emitToGuild(guild.id, "category:created", () => category);
      return reply.code(201).send(category);
    } catch (e) {
      throw isNameTaken(e) ? NAME_TAKEN : e;
    }
  });

  app.patch<{ Params: Params }>("/guilds/:guildId/categories/:categoryId", async (req, reply) => {
    const { guild } = await manageChannels(req.params.guildId, req.userId);
    const body = parse(categoryNameSchema, req.body, reply);
    if (!body) return;
    const { categoryId } = req.params;
    if (!isUuid(categoryId)) throw NOT_FOUND;
    try {
      const { count } = await prisma.category.updateMany({ where: { id: categoryId, guildId: guild.id }, data: { name: body.name } });
      if (!count) throw NOT_FOUND;
    } catch (e) {
      throw isNameTaken(e) ? NAME_TAKEN : e;
    }
    const category = await prisma.category.findUniqueOrThrow({ where: { id: categoryId } });
    await app.audit(guild.id, req.userId, "channel.category_update", { targetId: category.id, meta: { name: category.name } });
    await app.realtime.emitToGuild(guild.id, "category:updated", () => category);
    return category;
  });

  app.delete<{ Params: Params }>("/guilds/:guildId/categories/:categoryId", async (req, reply) => {
    const { guild } = await manageChannels(req.params.guildId, req.userId);
    const { categoryId } = req.params;
    if (!isUuid(categoryId)) throw NOT_FOUND;
    const moved = await prisma.$transaction(async (tx) => {
      await lockGuild(tx, guild.id);
      const { name } = (await tx.category.findFirst({ where: { id: categoryId, guildId: guild.id } })) ?? { name: "" };
      const moved = await removeCategory(tx, guild.id, categoryId); // 404 when it is not this guild's
      await app.audit(guild.id, req.userId, "channel.category_delete", { targetId: categoryId, meta: { name }, tx });
      return moved;
    });
    await app.realtime.emitToGuild(guild.id, "category:deleted", (canSee) => ({
      guildId: guild.id,
      categoryId,
      channels: moved.filter((c) => canSee(c.id)),
    }));
    return reply.code(204).send();
  });

  app.put<{ Params: Params }>("/guilds/:guildId/layout", async (req, reply) => {
    const access = await manageChannels(req.params.guildId, req.userId);
    const { guild } = access;
    const layout = parse(layoutSchema, req.body, reply);
    if (!layout) return;
    const canView = (channel: Parameters<typeof bitsInChannel>[1]) => hasPermission(bitsInChannel(access, channel), Permission.VIEW_CHANNEL);
    const result = await prisma.$transaction(async (tx) => {
      const applied = await applyLayout(tx, guild.id, layout, canView);
      await app.audit(guild.id, req.userId, "channel.layout_update", { tx }); // one entry per layout change, however many rows moved
      return applied;
    });
    const payload = (canSee: (id: string) => boolean) => ({
      guildId: guild.id,
      categories: result.categories,
      channels: result.channels.filter((c) => canSee(c.id)),
    });
    await app.realtime.emitToGuild(guild.id, "layout:updated", payload);
    return payload((id) => !result.hidden.has(id));
  });
}
