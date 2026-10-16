import { hasPermission, Permission } from "@loop/shared";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../db.js";
import { memberChannelPermissions } from "../guilds/access.js";
import type { Livekit, Seat } from "./livekit.js";
import { channelIdOfRoom, voiceRoom } from "./rooms.js";

declare module "fastify" {
  interface FastifyInstance {
    voice: Voice;
  }
}

export type VoiceMod = { serverMute: boolean; serverDeafen: boolean } | null | undefined;

/**
 * What a member may do in a voice channel: their bits there MINUS a moderator's server mute / deafen (never plus).
 * A deafen takes the microphone too (nobody talks into a room they cannot hear).
 */
export const voiceRights = (perms: number, mod?: VoiceMod) => ({
  connect: hasPermission(perms, Permission.VIEW_CHANNEL | Permission.CONNECT),
  speak: hasPermission(perms, Permission.SPEAK) && !mod?.serverMute && !mod?.serverDeafen,
  video: hasPermission(perms, Permission.VIDEO),
  stream: hasPermission(perms, Permission.STREAM),
  listen: !mod?.serverDeafen,
});

/** The participant list clients get (`voice:update`, GET .../voice): server mute / deafen come from the database, never from client metadata. */
export async function seatDtos(guildId: string, seats: Seat[]) {
  const mods = seats.length ? await voiceMods(guildId, seats.map((s) => s.userId)) : new Map();
  return seats.map(({ userId, username, sharing }) => ({ userId, username, sharing, serverMute: !!mods.get(userId)?.serverMute, serverDeafen: !!mods.get(userId)?.serverDeafen }));
}

/** The server mute / deafen of these members of a guild, by user id. */
export async function voiceMods(guildId: string, userIds: string[]) {
  const rows = await prisma.voiceModState.findMany({ where: { guildId, userId: { in: userIds } } });
  return new Map(rows.map((r) => [r.userId, r]));
}

/**
 * Keeps live LiveKit sessions inside the member's current rights. Tokens are only checked when LiveKit lets
 * someone in, so every rights change ends up here. All entry points swallow and log failures: the HTTP request
 * that triggered the change must not fail because LiveKit is down.
 * ponytail: if LiveKit is unreachable when rights are revoked, the user keeps their session until the next
 * reconcile() pass (server.ts runs it every minute) or until they leave; upgrade = retry queue.
 */
export function createVoice(livekit: Livekit, log: FastifyBaseLogger) {
  const guard = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      log.error({ err: String((e as Error)?.message) }, `voice ${what} failed`);
    }
  };

  /** Channels among `channelIds` whose room exists; LiveKit only keeps rooms that were recently used. */
  const withRooms = async (channelIds: string[]) => {
    if (!channelIds.length) return []; // listRooms([]) would list every room
    return (await livekit.listRooms(channelIds.map(voiceRoom))).map((r) => channelIdOfRoom(r.name)!);
  };

  /** Recompute every (or only `userIds`') participant of these channels and remove / downgrade whoever lost rights. */
  async function enforceChannels(guildId: string, channelIds: string[], userIds?: string[]) {
    const rooms = await Promise.all(channelIds.map(async (id) => ({ id, seats: await livekit.participants(voiceRoom(id)) })));
    const wanted = rooms.flatMap((r) => r.seats.map((s) => s.userId)).filter((u) => !userIds || userIds.includes(u));
    if (!wanted.length) return;
    const perms = new Map((await memberChannelPermissions(guildId, wanted)).map((m) => [m.userId, m.perms]));
    const mods = await voiceMods(guildId, wanted);
    const jobs: Promise<void>[] = [];
    for (const { id, seats } of rooms) {
      for (const seat of seats) {
        if (userIds && !userIds.includes(seat.userId)) continue;
        // a non-member has no entry: no bits at all
        const rights = voiceRights(perms.get(seat.userId)?.get(id) ?? 0, mods.get(seat.userId));
        const room = voiceRoom(id);
        if (!rights.connect) jobs.push(guard("remove", () => livekit.removeParticipant(room, seat.userId)));
        else if (rights.speak !== seat.speak || rights.video !== seat.video || rights.stream !== seat.stream || rights.listen !== seat.listen) {
          jobs.push(guard("downgrade", () => livekit.setRights(room, seat.userId, rights)));
        }
      }
    }
    await Promise.all(jobs);
  }

  const closeRooms = async (channelIds: string[]) => {
    if (!channelIds.length) return;
    for (const r of await livekit.listRooms(channelIds.map(voiceRoom))) await livekit.deleteRoom(r.name);
  };

  return {
    /** A guild's rights changed (role, overwrite, ownership): re-check who is in its voice channels. */
    enforce: (guildId: string, userIds?: string[]) =>
      guard("enforce", async () => {
        const channels = await prisma.channel.findMany({ where: { guildId, type: "VOICE" }, select: { id: true } });
        await enforceChannels(guildId, await withRooms(channels.map((c) => c.id)), userIds);
      }),

    /** The user lost access to these channels (left, kicked): out of any voice room among them. */
    removeUser: (userId: string, channelIds: string[]) =>
      guard("remove user", async () => {
        for (const id of await withRooms(channelIds)) await livekit.removeParticipant(voiceRoom(id), userId);
      }),

    /** Channels are gone (deleted, or their guild was): close their rooms. */
    closeChannels: (channelIds: string[]) => guard("close rooms", () => closeRooms(channelIds)),

    /**
     * Safety net for missed enforcement (LiveKit was down, a rejoin with a token issued before the revocation):
     * the same check over every voice room; rooms of channels that no longer exist are closed.
     */
    reconcile: () =>
      guard("reconcile", async () => {
        const rooms = await livekit.listRooms();
        const ids = rooms.flatMap((r) => channelIdOfRoom(r.name) ?? []);
        const channels = await prisma.channel.findMany({ where: { id: { in: ids }, type: "VOICE" }, select: { id: true, guildId: true } });
        await closeRooms(ids.filter((id) => !channels.some((c) => c.id === id)));
        for (const guildId of new Set(channels.map((c) => c.guildId))) {
          await enforceChannels(guildId, channels.filter((c) => c.guildId === guildId).map((c) => c.id));
        }
      }),
  };
}

export type Voice = ReturnType<typeof createVoice>;
