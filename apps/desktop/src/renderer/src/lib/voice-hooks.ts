import { useState } from "react";
import { useStore } from "zustand";
import { voice, voicePresence } from "./app";
import { sharedStreams, stageModel } from "./stream-stage";
import { participantsFor, serverFlagsOf, type Participant } from "./voice-presence";
import { indicatorsOf, type Indicator } from "./voice-flags";
import { isActive, type VoiceStatus } from "./voice";
export { isActive };
const isLive = (status: VoiceStatus) => status === "connected" || status === "reconnecting";

/** The pushed / fetched lists and the live room (when we are in one): what `participantsFor` needs. */
export function useVoiceSnapshot() {
  const lists = useStore(voicePresence.store, (s) => s.lists);
  const target = useStore(voice.store, (s) => s.target);
  const status = useStore(voice.store, (s) => s.status);
  const participants = useStore(voice.store, (s) => s.participants);
  const live = target?.kind === "channel" && isLive(status) ? { channelId: target.id, participants } : null;
  return { lists, live };
}

/** Who is in a voice channel: the live room if we are in it, else the pushed / fetched list. */
export function useVoiceParticipants(channelId: string): Participant[] {
  const { lists, live } = useVoiceSnapshot();
  return participantsFor(channelId, lists, live);
}

/** The icons to show for someone in a room: our own state is read from the session (always current), theirs from the room. */
export function useIndicators(p: Participant): Indicator[] {
  const micEnabled = useStore(voice.store, (s) => s.micEnabled);
  const deafened = useStore(voice.store, (s) => s.deafened);
  const mine = useStore(voice.store, (s) => `${s.serverMuted ? "mute" : ""} ${s.serverDeafened ? "deafen" : ""}`);
  const theirs = useStore(voicePresence.store, (s) => serverFlagsOf(s.lists, p.userId));
  const server = p.isLocal ? mine : theirs; // ours: the session (token + voice:moderated) knows first
  const flags = { serverMute: server.includes("mute"), serverDeafen: server.includes("deafen") };
  return indicatorsOf(p.isLocal ? { micOff: !micEnabled, deafened, ...flags } : { ...p, ...flags });
}

/** Which stream is on the big stage and which go to the strip (the viewer's pick, else see `stageModel`); `staged` is the participant on stage. */
export function useStreamStage(people: Participant[], here: boolean) {
  const watching = useStore(voice.store, (s) => s.watching);
  const [picked, setPicked] = useState<string | null>(null);
  const shared = sharedStreams(people, here);
  const { stage, strip } = stageModel(
    shared.map((p) => ({ userId: p.userId, isLocal: !!p.isLocal })),
    watching,
    picked,
  );
  return { stage, strip, staged: shared.find((p) => p.userId === stage?.userId), setPicked };
}
