import { hasPermission, Permission } from "@loop/shared";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { seatOf } from "./move-members";
import type { Channel } from "./permissions";
import type { Participant, Seat } from "./voice-presence";

export type VoiceModButton = { label: MessageKey; body: { mute: boolean } | { deafen: boolean } };

/**
 * The card's server mute / deafen buttons (only hides UI: the server decides). None unless the person sits in a voice
 * channel of this server, is not us, the kick rule lets us act on them (`canActOn`: not the owner, strictly below us),
 * and we hold MUTE_MEMBERS / DEAFEN_MEMBERS in THAT channel. The current state comes from the server's lists.
 */
export function voiceModButtons(i: {
  userId: string;
  selfId: string;
  canActOn: boolean;
  channels: Channel[];
  lists: Record<string, Seat[]>;
  live: { channelId: string; participants: Participant[] } | null;
  bitsOf: (channel: Channel) => number;
}): { channel: Channel; buttons: VoiceModButton[] } | null {
  if (i.userId === i.selfId || !i.canActOn) return null;
  const channel = seatOf(i.userId, i.channels, i.lists, i.live);
  if (!channel) return null;
  const bits = i.bitsOf(channel);
  const seat = i.lists[channel.id]?.find((s) => s.userId === i.userId);
  const buttons: VoiceModButton[] = [];
  if (hasPermission(bits, Permission.MUTE_MEMBERS)) buttons.push(seat?.serverMute ? { label: "voice.mod.unmute", body: { mute: false } } : { label: "voice.mod.mute", body: { mute: true } });
  if (hasPermission(bits, Permission.DEAFEN_MEMBERS)) buttons.push(seat?.serverDeafen ? { label: "voice.mod.undeafen", body: { deafen: false } } : { label: "voice.mod.deafen", body: { deafen: true } });
  return buttons.length ? { channel, buttons } : null;
}

type ModState = { serverMuted: boolean; serverDeafened: boolean };
/** What to tell us after `voice:moderated` (one line per flag that changed; nothing for an echo of the same state). */
export function moderationNotices(before: ModState, after: { serverMute: boolean; serverDeafen: boolean }, by: string): string[] {
  const out: string[] = [];
  if (after.serverDeafen !== before.serverDeafened) out.push(t(after.serverDeafen ? "voice.mod.deafened" : "voice.mod.undeafened", { by }));
  if (after.serverMute !== before.serverMuted) out.push(t(after.serverMute ? "voice.mod.muted" : "voice.mod.unmuted", { by }));
  return out;
}
