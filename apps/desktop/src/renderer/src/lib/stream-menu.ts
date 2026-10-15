import { audioAllowed, FPS_CHOICES, RESOLUTIONS, type ShareChoice } from "./golive";

/** Why the stream's sound switch cannot be used: this system cannot carry it, or the source (a camera) has none. */
export type AudioBlock = "os" | "device";

export type StreamMenuRow =
  | { id: "stop" | "change"; kind: "action" }
  | { id: "resolution"; kind: "radio"; options: { value: (typeof RESOLUTIONS)[number]; checked: boolean }[] }
  | { id: "fps"; kind: "radio"; options: { value: (typeof FPS_CHOICES)[number]; checked: boolean }[] }
  | { id: "audio"; kind: "check"; checked: boolean; blocked: AudioBlock | null };

/** The rows of the menu on the share button while streaming, with the current quality and sound marked. */
export function streamMenu(stream: ShareChoice, platform: string): StreamMenuRow[] {
  const blocked: AudioBlock | null = audioAllowed(stream.source.kind, platform) ? null : stream.source.kind === "device" ? "device" : "os";
  return [
    { id: "stop", kind: "action" },
    { id: "change", kind: "action" },
    { id: "resolution", kind: "radio", options: RESOLUTIONS.map((value) => ({ value, checked: stream.quality.resolution === value })) },
    { id: "fps", kind: "radio", options: FPS_CHOICES.map((value) => ({ value, checked: stream.quality.fps === value })) },
    { id: "audio", kind: "check", checked: !blocked && stream.audio, blocked },
  ];
}
