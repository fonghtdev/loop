import { useStore } from "zustand";
import { voice, voicePresence } from "./app";
import { participantsFor, type Participant } from "./voice-presence";
import { indicatorsOf, type Indicator } from "./voice-flags";
import { isActive, type VoiceStatus } from "./voice";
export { isActive };
const isLive = (status: VoiceStatus) => status === "connected" || status === "reconnecting";

/** Who is in a voice channel: the live room if we are in it, else the pushed / fetched list. */
export function useVoiceParticipants(channelId: string): Participant[] {
  const lists = useStore(voicePresence.store, (s) => s.lists);
  const target = useStore(voice.store, (s) => s.target);
  const status = useStore(voice.store, (s) => s.status);
  const participants = useStore(voice.store, (s) => s.participants);
  const live = target?.kind === "channel" && isLive(status) ? { channelId: target.id, participants } : null;
  return participantsFor(channelId, lists, live);
}

/** The icons to show for someone in a room: our own state is read from the session (always current), theirs from the room. */
export function useIndicators(p: Participant): Indicator[] {
  const micEnabled = useStore(voice.store, (s) => s.micEnabled);
  const deafened = useStore(voice.store, (s) => s.deafened);
  return indicatorsOf(p.isLocal ? { micOff: !micEnabled, deafened } : p);
}
