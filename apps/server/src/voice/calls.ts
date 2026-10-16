import type { FastifyInstance } from "fastify";
import { MAX_DM_CALL_PARTICIPANTS, MAX_GROUP_DM, startCallSchema } from "@loop/shared";
import { prisma } from "../db.js";
import { parse } from "../http.js";
import { pair, requireDm, requireDmWritable, requireUser } from "../social/access.js";
import { joinRoom } from "./join.js";
import { dmRoom } from "./rooms.js";

const CALL_TIMEOUTS = { emptyTimeout: 60, departureTimeout: 10 };

export function callRoutes(app: FastifyInstance) {
  /**
   * Start or answer a call. Same rule as sending a DM (a pair: still friends, no block; a group: participant).
   * The first one in the room rings every other participant; joining an occupied room is an answer and rings nobody.
   * A group room holds up to MAX_GROUP_DM (only participants get a token, and a group never has more).
   * ponytail: "first" is decided from room occupancy at request time, so two near-simultaneous calls can both
   * ring; upgrade = a short-lived "ringing" key in Redis.
   */
  app.post<{ Params: { dmId: string } }>("/dms/:dmId/call", async (req, reply) => {
    const { dm, otherIds } = await requireDmWritable(req.params.dmId, req.userId);
    const body = parse(startCallSchema, req.body ?? {}, reply);
    if (!body) return;
    const me = await requireUser({ id: req.userId });
    const { empty, body: join } = await joinRoom(app, me, dmRoom(dm.id), {
      max: dm.kind === "GROUP" ? MAX_GROUP_DM : MAX_DM_CALL_PARTICIPANTS,
      rights: { speak: true, video: true, stream: true, listen: true },
      timeouts: CALL_TIMEOUTS,
    });
    if (empty) app.realtime.emitToUsers(otherIds, "call:incoming", { dmChannelId: dm.id, from: me, video: body.video });
    return join;
  });

  /**
   * Participants only; deliberately not tied to friendship, so refusing a call from someone just unfriended works.
   * In a group it only says that this one person declined (clients keep ringing the rest).
   */
  app.post<{ Params: { dmId: string } }>("/dms/:dmId/call/decline", async (req, reply) => {
    const { dm, otherIds } = await requireDm(req.params.dmId, req.userId);
    app.realtime.emitToUsers(otherIds, "call:declined", { dmChannelId: dm.id, by: { id: req.userId } });
    return reply.code(204).send();
  });
}

/**
 * The pair can no longer talk (blocked, unfriended): close their call room, which disconnects both, and tell
 * both sides. A LiveKit failure is logged, never thrown into the request that caused the block.
 */
export async function endDmCall(app: FastifyInstance, a: string, b: string) {
  try {
    const dm = await prisma.dmChannel.findUnique({ where: { userLowId_userHighId: pair(a, b) } });
    if (!dm || !(await app.livekit.listRooms([dmRoom(dm.id)])).length) return; // no call, nothing to end
    await app.livekit.deleteRoom(dmRoom(dm.id));
    app.realtime.emitToUsers([a, b], "call:ended", { dmChannelId: dm.id });
  } catch (e) {
    app.log.error({ err: String((e as Error)?.message) }, "ending dm call failed");
  }
}

/** Someone left or was removed from a group: out of its call room if they are in it (best effort, like endDmCall). */
export async function leaveDmCall(app: FastifyInstance, dmId: string, userId: string) {
  try {
    await app.livekit.removeParticipant(dmRoom(dmId), userId);
  } catch (e) {
    app.log.error({ err: String((e as Error)?.message) }, "removing from dm call failed");
  }
}
