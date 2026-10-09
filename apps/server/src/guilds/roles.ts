import type { FastifyInstance } from "fastify";
import { createRoleSchema, overwriteSchema, Permission, updateRoleSchema } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import {
  NOT_FOUND,
  requireChannelPermission,
  requireGuildPermission,
  requireHeld,
  requireHoldsRole,
  requireManageableMember,
  requireMember,
  requireRoleBelow,
} from "./access.js";
import { lockGuild } from "./routes.js";

type Params = { guildId: string; roleId: string; userId: string; channelId: string };

const EVERYONE_FIXED = new HttpError(400, "@everyone cannot be renamed, deleted or assigned");
const manageRoles = (guildId: string, userId: string) =>
  requireGuildPermission(guildId, userId, Permission.MANAGE_ROLES);

// ponytail: no role reorder endpoint and no cap on roles per guild; add both when the client needs them
export function roleRoutes(app: FastifyInstance) {
  app.get<{ Params: Params }>("/guilds/:guildId/roles", async (req) => {
    const { guild } = await requireMember(req.params.guildId, req.userId);
    return prisma.role.findMany({ where: { guildId: guild.id }, orderBy: { position: "asc" } });
  });

  /**
   * New roles go to the bottom (position 1, just above @everyone) and push every other role up one, so the
   * order of existing roles never changes. That keeps rule 1: the new role is below the creator's top role
   * whenever the creator holds any role, so a caller with only @everyone cannot create roles.
   */
  app.post<{ Params: Params }>("/guilds/:guildId/roles", async (req, reply) => {
    const access = await manageRoles(req.params.guildId, req.userId);
    const body = parse(createRoleSchema, req.body, reply);
    if (!body) return;
    if (access.top < 1) throw new HttpError(403, "You need a role above the new one");
    requireHeld(access.perms, body.permissions);
    const role = await prisma.$transaction(async (tx) => {
      await lockGuild(tx, access.guild.id);
      await tx.role.updateMany({ where: { guildId: access.guild.id, position: { gte: 1 } }, data: { position: { increment: 1 } } });
      return tx.role.create({ data: { guildId: access.guild.id, ...body, position: 1 } });
    });
    return reply.code(201).send(role);
  });

  app.patch<{ Params: Params }>("/guilds/:guildId/roles/:roleId", async (req, reply) => {
    const access = await manageRoles(req.params.guildId, req.userId);
    const body = parse(updateRoleSchema, req.body, reply);
    if (!body) return;
    const role = await requireRoleBelow(access, req.params.roleId);
    if (role.id === access.guild.id && body.name !== undefined) throw EVERYONE_FIXED;
    if (body.permissions !== undefined) requireHeld(access.perms, role.permissions ^ body.permissions);
    const { count } = await prisma.role.updateMany({ where: { id: role.id }, data: body });
    if (count === 0) throw NOT_FOUND; // deleted since the lookup
    if (body.permissions !== undefined) await app.realtime.revalidate(access.guild.id);
    return { ...role, ...body };
  });

  app.delete<{ Params: Params }>("/guilds/:guildId/roles/:roleId", async (req, reply) => {
    const access = await manageRoles(req.params.guildId, req.userId);
    const role = await requireRoleBelow(access, req.params.roleId);
    if (role.id === access.guild.id) throw EVERYONE_FIXED;
    await requireHoldsRole(access, role);
    await prisma.role.deleteMany({ where: { id: role.id } }); // cascades to assignments and overwrites
    await app.realtime.revalidate(access.guild.id); // a deleted role can take an overwrite allow with it
    return reply.code(204).send();
  });

  /** Assign (PUT, idempotent) or unassign (DELETE). Both revalidate: a role's deny overwrites can hide channels too. */
  for (const method of ["PUT", "DELETE"] as const) {
    app.route<{ Params: Params }>({
      method,
      url: "/guilds/:guildId/members/:userId/roles/:roleId",
      handler: async (req, reply) => {
        const access = await manageRoles(req.params.guildId, req.userId);
        const role = await requireRoleBelow(access, req.params.roleId);
        if (role.id === access.guild.id) throw EVERYONE_FIXED;
        await requireHoldsRole(access, role);
        const { userId } = req.params;
        await requireManageableMember(access, userId, true);
        const key = { guildId: access.guild.id, userId, roleId: role.id };
        if (method === "PUT") await prisma.memberRole.createMany({ data: key, skipDuplicates: true });
        else await prisma.memberRole.deleteMany({ where: key });
        await app.realtime.revalidate(access.guild.id, [userId]);
        return reply.code(204).send();
      },
    });
  }

  /**
   * Set (PUT) or remove (DELETE) a role's overwrite on a channel. Needs MANAGE_ROLES and sight of the channel,
   * the role strictly below the caller (rule 1), and every bit touched, old and new, held in this channel
   * (rule 2: lifting a deny grants it just like an allow does).
   */
  for (const method of ["PUT", "DELETE"] as const) {
    app.route<{ Params: Params }>({
      method,
      url: "/channels/:channelId/overwrites/:roleId",
      handler: async (req, reply) => {
        const { channel, access, perms } = await requireChannelPermission(req.params.channelId, req.userId, Permission.MANAGE_ROLES);
        const body = method === "PUT" ? parse(overwriteSchema, req.body, reply) : { allow: 0, deny: 0 };
        if (!body) return;
        const role = await requireRoleBelow(access, req.params.roleId);
        const old = channel.overwrites.find((o) => o.roleId === role.id) ?? { allow: 0, deny: 0 };
        requireHeld(perms, old.allow | old.deny | body.allow | body.deny);
        const key = { channelId: channel.id, roleId: role.id };
        if (method === "PUT") {
          await prisma.channelOverwrite.upsert({
            where: { channelId_roleId: key },
            create: { ...key, guildId: access.guild.id, ...body },
            update: body,
          });
        } else {
          await prisma.channelOverwrite.deleteMany({ where: key });
        }
        await app.realtime.revalidate(access.guild.id);
        return method === "PUT" ? { ...key, ...body } : reply.code(204).send();
      },
    });
  }
}
