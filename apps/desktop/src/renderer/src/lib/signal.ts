import type { MessageKey } from "../i18n/vi";
import type { ConnectionQuality, VoiceStatus } from "./voice";

export type Signal = { level: "full" | "medium" | "low" | "lost"; tone: "good" | "warn" | "bad" | "idle"; label: MessageKey };

/** The bars of the voice panel from what is measured: LiveKit's quality rating while connected, the session status otherwise. */
export function signalOf(status: VoiceStatus, quality: ConnectionQuality): Signal {
  if (status === "reconnecting") return { level: "low", tone: "warn", label: "voice.signal.reconnecting" };
  if (status !== "connected") return { level: "low", tone: "idle", label: "voice.signal.connecting" };
  switch (quality) {
    case "excellent":
      return { level: "full", tone: "good", label: "voice.signal.excellent" };
    case "good":
      return { level: "medium", tone: "good", label: "voice.signal.good" };
    case "poor":
      return { level: "low", tone: "warn", label: "voice.signal.poor" };
    case "lost":
      return { level: "lost", tone: "bad", label: "voice.signal.lost" };
    default:
      return { level: "medium", tone: "idle", label: "voice.signal.unknown" };
  }
}
