import { prisma } from "../db.js";
import { HttpError } from "../http.js";
import { isUuid, NOT_FOUND } from "../guilds/access.js";

export { isUuid, NOT_FOUND };

/**
 * Pairs are stored unordered-as-ordered (low < high, a CHECK in the DB), so one row means one relationship.
 * String order equals Postgres uuid order: ids are lowercase hex of equal length.
 */
export const pair = (a: string, b: string) =>
  a < b ? { userLowId: a, userHighId: b } : { userLowId: b, userHighId: a };

export const otherOf = (p: { userLowId: string; userHighId: string }, me: string) =>
  p.userLowId === me ? p.userHighId : p.userLowId;

/** A block in EITHER direction. */
export const isBlockedBetween = async (a: string, b: string) =>
  (await prisma.block.count({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] } })) > 0;

/** Everyone with a block against `userId` in either direction (presence and the like stay hidden between them). */
export async function blockedWith(userId: string) {
  const rows = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  return new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)));
}

export const areFriends = async (a: string, b: string) =>
  (await prisma.friendship.count({ where: { ...pair(a, b), status: "ACCEPTED" } })) > 0;

/**
 * Who receives `userId`'s presence: accepted friends and members of every guild shared with them, minus anyone
 * with a block in either direction, never the user themself. One query.
 */
// ponytail: O(members of every shared guild) per presence transition; upgrade = per-guild rooms (kept in sync on
// join/leave/kick) or batching transitions, if big guilds make this hot.
export async function presenceAudience(userId: string) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT a.id::text AS id FROM (
      SELECT CASE WHEN f."userLowId" = ${userId}::uuid THEN f."userHighId" ELSE f."userLowId" END AS id
        FROM "Friendship" f
        WHERE f.status = 'ACCEPTED' AND (f."userLowId" = ${userId}::uuid OR f."userHighId" = ${userId}::uuid)
      UNION
      SELECT other."userId" FROM "Member" mine JOIN "Member" other ON other."guildId" = mine."guildId"
        WHERE mine."userId" = ${userId}::uuid
    ) a
    WHERE a.id <> ${userId}::uuid AND NOT EXISTS (
      SELECT 1 FROM "Block" b
      WHERE (b."blockerId" = ${userId}::uuid AND b."blockedId" = a.id) OR (b."blockedId" = ${userId}::uuid AND b."blockerId" = a.id)
    )`;
  return rows.map((r) => r.id);
}

export const userSelect = { id: true, username: true } as const; // never email/passwordHash

/** Malformed and unknown ids/usernames both give 404. */
export async function requireUser(where: { id: string } | { username: string }) {
  const user = "id" in where && !isUuid(where.id) ? null : await prisma.user.findUnique({ where, select: userSelect });
  if (!user) throw NOT_FOUND;
  return user;
}

/**
 * The user for "talk to this user" actions (friend request by name, open a DM): unknown and blocked (either
 * direction) all give the same 404, so a block cannot be told apart from a missing account.
 */
export async function requireReachableUser(where: { id: string } | { username: string }, me: string) {
  const user = await requireUser(where);
  if (user.id === me) throw new HttpError(400, "Not allowed on yourself");
  if (await isBlockedBetween(me, user.id)) throw NOT_FOUND;
  return user;
}

/** Sending in a DM needs a live friendship; a block removes it, so unfriend and block give the same 403. */
export async function requireFriendsUnblocked(a: string, b: string) {
  if (!(await areFriends(a, b)) || (await isBlockedBetween(a, b))) throw new HttpError(403, "Not friends");
}

/** The DM channel and the other participant. Non-participants, unknown and malformed ids all give 404. */
export async function requireDm(dmId: string, userId: string) {
  const dm = isUuid(dmId) ? await prisma.dmChannel.findUnique({ where: { id: dmId } }) : null;
  if (!dm || (dm.userLowId !== userId && dm.userHighId !== userId)) throw NOT_FOUND;
  return { dm, otherId: otherOf(dm, userId) };
}
