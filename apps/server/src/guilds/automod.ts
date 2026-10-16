import type { AutoModRule } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { AUTOMOD_BLOCKED, type AutoModRuleDto, createAutoModRuleSchema, hasPermission, matchesKeywords, MAX_AUTOMOD_RULES, Permission, updateAutoModRuleSchema } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import { isUuid, NOT_FOUND, requireGuildPermission } from "./access.js";
import { lockGuild } from "./routes.js";

type Params = { guildId: string; ruleId: string };

const dto = (r: AutoModRule): AutoModRuleDto => ({ ...r, createdAt: r.createdAt.toISOString() });
/** No bit of its own: the owner and ADMINISTRATOR (who hold every bit) manage the rules. */
const requireAdmin = (guildId: string, userId: string) => requireGuildPermission(guildId, userId, Permission.ADMINISTRATOR);

/**
 * Runs BEFORE a guild message (channel or thread) is written, on create and on edit: a match is a 403 and nothing of the
 * message is stored. Exempt: whoever may manage messages in that channel (the owner and ADMINISTRATOR hold every bit,
 * so `perms` covers them too). Bots are not exempt. The entry in the audit log is rate limited (one per user and rule
 * per minute). ponytail: one indexed query for the guild's rules per message; cache them if sending ever gets hot.
 */
export async function enforceAutoMod(app: FastifyInstance, channel: { id: string; guildId: string }, userId: string, perms: number, content: string) {
  if (!content || hasPermission(perms, Permission.MANAGE_MESSAGES)) return;
  const rules = await prisma.autoModRule.findMany({ where: { guildId: channel.guildId, enabled: true }, select: { id: true, name: true, keywords: true } });
  const hit = rules.find((r) => matchesKeywords(content, r.keywords));
  if (!hit) return;
  await app.audit.block(channel.guildId, userId, hit, channel.id);
  throw new HttpError(403, AUTOMOD_BLOCKED);
}

export function automodRoutes(app: FastifyInstance) {
  app.get<{ Params: Params }>("/guilds/:guildId/automod/rules", async (req) => {
    const { guild } = await requireAdmin(req.params.guildId, req.userId);
    const rules = await prisma.autoModRule.findMany({ where: { guildId: guild.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    return { rules: rules.map(dto) };
  });

  /** At most 5 per guild (409), counted under the guild lock so parallel creates cannot overshoot. */
  app.post<{ Params: Params }>("/guilds/:guildId/automod/rules", async (req, reply) => {
    const { guild } = await requireAdmin(req.params.guildId, req.userId);
    const body = parse(createAutoModRuleSchema, req.body, reply);
    if (!body) return;
    const rule = await prisma.$transaction(async (tx) => {
      await lockGuild(tx, guild.id);
      if ((await tx.autoModRule.count({ where: { guildId: guild.id } })) >= MAX_AUTOMOD_RULES) throw new HttpError(409, `AutoMod rule limit reached (${MAX_AUTOMOD_RULES})`);
      const created = await tx.autoModRule.create({ data: { ...body, guildId: guild.id, createdById: req.userId } });
      await app.audit(guild.id, req.userId, "automod.rule_create", { targetId: created.id, meta: { name: created.name }, tx });
      return created;
    });
    return reply.code(201).send(dto(rule));
  });

  app.patch<{ Params: Params }>("/guilds/:guildId/automod/rules/:ruleId", async (req, reply) => {
    const { guild } = await requireAdmin(req.params.guildId, req.userId);
    const body = parse(updateAutoModRuleSchema, req.body, reply);
    if (!body) return;
    const { ruleId } = req.params;
    if (!isUuid(ruleId) || !(await prisma.autoModRule.updateMany({ where: { id: ruleId, guildId: guild.id }, data: body })).count) throw NOT_FOUND;
    const rule = await prisma.autoModRule.findUniqueOrThrow({ where: { id: ruleId } });
    await app.audit(guild.id, req.userId, "automod.rule_update", { targetId: rule.id, meta: { name: rule.name, changed: Object.keys(body) as ("name" | "enabled" | "keywords")[] } });
    return dto(rule);
  });

  app.delete<{ Params: Params }>("/guilds/:guildId/automod/rules/:ruleId", async (req, reply) => {
    const { guild } = await requireAdmin(req.params.guildId, req.userId);
    const { ruleId } = req.params;
    const rule = isUuid(ruleId) ? await prisma.autoModRule.findFirst({ where: { id: ruleId, guildId: guild.id } }) : null;
    if (!rule || !(await prisma.autoModRule.deleteMany({ where: { id: rule.id } })).count) throw NOT_FOUND;
    await app.audit(guild.id, req.userId, "automod.rule_delete", { targetId: rule.id, meta: { name: rule.name } });
    return reply.code(204).send();
  });
}
