import { useStore } from "zustand";
import { voice, voicePresence } from "./app";
import { participantsFor, type Participant } from "./voice-presence";
import type { VoiceStatus } from "./voice";

/** A session that holds (or is acquiring) a room; the voice bar shows for these. */
export const isActive = (status: VoiceStatus) => status !== "idle" && status !== "disconnected";
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
