import { hasPermission, Permission } from "@loop/shared";
import type { Channel } from "./permissions";
import { participantsFor, type Participant, type Seat } from "./voice-presence";

/** Set on dragstart of a person under a voice channel; kept apart from LAYOUT_DRAG (channel rows) and from "Files". */
export const MOVE_DRAG = "application/x-loop-move";
export const isMoveDrag = (dt: { types?: readonly string[] } | null | undefined): boolean => !!dt?.types && Array.from(dt.types).includes(MOVE_DRAG);

/** Who is dragged: the person, and the server + voice channel they sit in. */
export type MovePayload = { userId: string; guildId: string; channelId: string };
export const encodeMove = (p: MovePayload) => JSON.stringify(p);

/** The payload of a drop, or null for anything that is not exactly three strings (the data comes from outside our code). */
export function parseMove(raw: string): MovePayload | null {
  try {
    const { userId, guildId, channelId } = JSON.parse(raw) as Record<string, unknown>;
    return typeof userId === "string" && typeof guildId === "string" && typeof channelId === "string" ? { userId, guildId, channelId } : null;
  } catch {
    return null;
  }
}

type Bits = (channel: Pick<Channel, "overwrites">) => number;
/** MOVE_MEMBERS in a channel (needs both the one they leave and the one they join, like the server). */
export const mayMove = (bitsInChannel: number) => hasPermission(bitsInChannel, Permission.MOVE_MEMBERS);

/** A drop is accepted on a voice channel of the same server, other than the one the person sits in, where we may move people. */
export const canDropOn = (drag: MovePayload, dest: Channel, bitsInDest: number) =>
  dest.type === "VOICE" && dest.guildId === drag.guildId && dest.id !== drag.channelId && mayMove(bitsInDest);

/** The guild's voice channel a person sits in (the live room when it is ours, else the pushed lists). */
export function seatOf(userId: string, channels: Channel[], lists: Record<string, Seat[]>, live: { channelId: string; participants: Participant[] } | null) {
  return channels.find((c) => c.type === "VOICE" && participantsFor(c.id, lists, live).some((p) => p.userId === userId)) ?? null;
}

/**
 * The card's "Chuyển tới…": null (hidden) unless the person sits in a voice channel where we may move people AND there is
 * another voice channel where we may too; `targets` are those channels in list order.
 */
export function moveOptions(i: { userId: string; channels: Channel[]; lists: Record<string, Seat[]>; live: { channelId: string; participants: Participant[] } | null; bitsOf: Bits }) {
  const source = seatOf(i.userId, i.channels, i.lists, i.live);
  if (!source || !mayMove(i.bitsOf(source))) return null;
  const targets = i.channels.filter((c) => c.type === "VOICE" && c.id !== source.id && mayMove(i.bitsOf(c)));
  return targets.length ? { source, targets } : null;
}
