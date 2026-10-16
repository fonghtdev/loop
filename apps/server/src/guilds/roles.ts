import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createRoleSchema, overwriteSchema, Permission, roleOrderSchema, type RolesUpdatedEvent, updateRoleSchema } from "@loop/shared";
import { prisma } from "../db.js";
import { HttpError, parse } from "../http.js";
import {
  NOT_FOUND,
  requireGuildChannel,
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
const EVERYONE_LAST = new HttpError(400, "@everyone always stays at the bottom");
const ROLES_CHANGED = new HttpError(409, "Roles changed, reload and try again");

/**
 * Rule 1 for a reorder by a non-owner whose top role is at `top`: the roles at or above it (theirs and those above)
 * must open the list in their current order, so every comparison with them stays as it was and nothing moves to or
 * above the caller. Renumbering gives every role a distinct position, so two of those roles sharing one (never made
 * by the API, only by old data) cannot keep their tie: only the owner may break it.
 */
export function keepsHigherRoles(roles: { id: string; position: number }[], order: string[], top: number) {
  const fixed = roles.filter((r) => r.position >= top).sort((a, b) => b.position - a.position);
  if (new Set(fixed.map((r) => r.position)).size !== fixed.length) return false;
  return fixed.every((r, i) => order[i] === r.id);
}
const manageRoles = (guildId: string, userId: string) =>
  requireGuildPermission(guildId, userId, Permission.MANAGE_ROLES);

// ponytail: no cap on roles per guild (the reorder body takes at most 250); add one before public launch
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
      const created = await tx.role.create({ data: { guildId: access.guild.id, ...body, position: 1 } });
      await app.audit(access.guild.id, req.userId, "role.create", { targetId: created.id, meta: { name: created.name, permissions: created.permissions }, tx });
      return created;
    });
    return reply.code(201).send(role);
  });

  /**
   * The complete list of roles but @everyone, highest first; positions become n..1 (@everyone stays 0). Members'
   * roles and permission bits do not change, only who outranks whom. 409 when the list is not exactly the current set.
   */
  app.put<{ Params: Params }>("/guilds/:guildId/roles/order", async (req, reply) => {
    const access = await manageRoles(req.params.guildId, req.userId);
    const body = parse(roleOrderSchema, req.body, reply);
    if (!body) return;
    const guildId = access.guild.id;
    if (body.roleIds.includes(guildId)) throw EVERYONE_LAST;
    const roles = await prisma.$transaction(async (tx) => {
      await lockGuild(tx, guildId);
      const current = await tx.role.findMany({ where: { guildId, NOT: { id: guildId } } });
      if (current.length !== body.roleIds.length || current.some((r) => !body.roleIds.includes(r.id))) throw ROLES_CHANGED;
      // the caller's rank re-read under the lock (a role change racing with this cannot widen it)
      const guild = await tx.guild.findUniqueOrThrow({ where: { id: guildId } });
      if (guild.ownerId !== req.userId) {
        const mine = new Set((await tx.memberRole.findMany({ where: { guildId, userId: req.userId } })).map((m) => m.roleId));
        const top = Math.max(0, ...current.filter((r) => mine.has(r.id)).map((r) => r.position));
        if (!keepsHigherRoles(current, body.roleIds, top)) throw new HttpError(403, "You can only reorder roles below your highest role");
      }
      const n = body.roleIds.length;
      for (const [i, id] of body.roleIds.entries()) {
        if (current.find((r) => r.id === id)!.position !== n - i) await tx.role.update({ where: { id }, data: { position: n - i } });
      }
      await app.audit(guildId, req.userId, "role.reorder", { tx });
      return tx.role.findMany({ where: { guildId }, orderBy: { position: "asc" } });
    });
    await app.realtime.revalidate(guildId); // bits are unchanged; kept so every rights change goes through one path
    await app.realtime.emitToGuild(guildId, "roles:updated", () => ({ guildId }) satisfies RolesUpdatedEvent);
    return roles;
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
    const changed = (["name", "permissions", "color"] as const).filter((k) => body[k] !== undefined);
    await app.audit(access.guild.id, req.userId, "role.update", { targetId: role.id, meta: { name: body.name ?? role.name, changed } });
    if (body.permissions !== undefined) await app.realtime.revalidate(access.guild.id);
    return { ...role, ...body };
  });

  app.delete<{ Params: Params }>("/guilds/:guildId/roles/:roleId", async (req, reply) => {
    const access = await manageRoles(req.params.guildId, req.userId);
    const role = await requireRoleBelow(access, req.params.roleId);
    if (role.id === access.guild.id) throw EVERYONE_FIXED;
    await requireHoldsRole(access, role);
    await prisma.role.deleteMany({ where: { id: role.id } }); // cascades to assignments and overwrites
    await app.audit(access.guild.id, req.userId, "role.delete", { targetId: role.id, meta: { name: role.name } });
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
        const { count } = method === "PUT" ? await prisma.memberRole.createMany({ data: key, skipDuplicates: true }) : await prisma.memberRole.deleteMany({ where: key });
        if (count) await app.audit(access.guild.id, req.userId, method === "PUT" ? "role.assign" : "role.unassign", { targetUserId: userId, targetId: role.id, meta: { name: role.name } });
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
        const { channel, access, perms } = await requireGuildChannel(req.params.channelId, req.userId, Permission.MANAGE_ROLES);
        const body = method === "PUT" ? parse(overwriteSchema, req.body, reply) : { allow: 0, deny: 0 };
        if (!body) return;
        const role = await requireRoleBelow(access, req.params.roleId);
        const old = channel.overwrites.find((o) => o.roleId === role.id) ?? { allow: 0, deny: 0 };
        requireHeld(perms, old.allow | old.deny | body.allow | body.deny);
        const key = { channelId: channel.id, roleId: role.id };
        let removed = 0;
        if (method === "PUT") {
          await prisma.channelOverwrite.upsert({
            where: { channelId_roleId: key },
            create: { ...key, guildId: access.guild.id, ...body },
            update: body,
          });
        } else {
          removed = (await prisma.channelOverwrite.deleteMany({ where: key })).count;
        }
        const at = { channel: channel.name, role: role.name };
        if (method === "PUT") await app.audit(access.guild.id, req.userId, "channel.overwrite_set", { targetId: channel.id, meta: { ...at, ...body } });
        else if (removed) await app.audit(access.guild.id, req.userId, "channel.overwrite_delete", { targetId: channel.id, meta: at });
        await app.realtime.revalidate(access.guild.id);
        return method === "PUT" ? { ...key, ...body } : reply.code(204).send();
      },
    });
  }

  /**
   * Set (PUT) or remove (DELETE) one member's overwrite on a channel. Same rules as a role's: MANAGE_ROLES and sight
   * of the channel; the member strictly below the caller (rule 1 as for kicks: not the owner, not yourself), so nobody
   * restricts or lifts someone at or above them; every bit touched, old and new, held in this channel (rule 2).
   */
  for (const method of ["PUT", "DELETE"] as const) {
    app.route<{ Params: Params }>({
      method,
      url: "/channels/:channelId/overwrites/members/:userId",
      handler: async (req, reply) => {
        const { channel, access, perms } = await requireGuildChannel(req.params.channelId, req.userId, Permission.MANAGE_ROLES);
        const body = method === "PUT" ? parse(overwriteSchema, req.body, reply) : { allow: 0, deny: 0 };
        if (!body) return;
        const { userId } = req.params;
        await requireManageableMember(access, userId, false);
        const old = channel.memberOverwrites.find((o) => o.userId === userId) ?? { allow: 0, deny: 0 };
        requireHeld(perms, old.allow | old.deny | body.allow | body.deny);
        const key = { channelId: channel.id, userId };
        let removed = 0;
        if (method === "PUT") {
          try {
            await prisma.channelMemberOverwrite.upsert({
              where: { channelId_userId: key },
              create: { ...key, guildId: access.guild.id, ...body },
              update: body,
            });
          } catch (e) {
            // the member left (or the channel went) since the check: the composite foreign keys refuse the row
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") throw NOT_FOUND;
            throw e;
          }
        } else {
          removed = (await prisma.channelMemberOverwrite.deleteMany({ where: key })).count;
        }
        const at = { targetUserId: userId, targetId: channel.id };
        if (method === "PUT") await app.audit(access.guild.id, req.userId, "channel.overwrite_set", { ...at, meta: { channel: channel.name, role: null, ...body } });
        else if (removed) await app.audit(access.guild.id, req.userId, "channel.overwrite_delete", { ...at, meta: { channel: channel.name, role: null } });
        await app.realtime.revalidate(access.guild.id, [userId]);
        return method === "PUT" ? { ...key, ...body } : reply.code(204).send();
      },
    });
  }
}
