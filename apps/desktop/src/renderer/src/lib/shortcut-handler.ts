import type { ShortcutAction } from "../../../shared/shortcut";
import type { SoundKind } from "./sounds";
import type { Voice } from "./voice";

/**
 * A global shortcut flips the mic or the hearing of the live session, through the same voice calls as the buttons (so the
 * canSpeak / deafen rules and the job queue apply). Outside a connected session it is ignored. The beep follows what really
 * changed: a refused toggle (no right to speak, deafened, device error) stays silent.
 */
export function createShortcutHandler({ store, toggleMic, toggleDeafen }: Pick<Voice, "store" | "toggleMic" | "toggleDeafen">, beep: (kind: SoundKind) => void) {
  return async (action: ShortcutAction) => {
    if (store.getState().status !== "connected") return;
    const key = action === "mic" ? "micEnabled" : "deafened";
    const before = store.getState()[key];
    await (action === "mic" ? toggleMic() : toggleDeafen());
    const after = store.getState()[key];
    if (after === before) return;
    // on = mic live / hearing; deafening is the "off" beep
    beep(action === "mic" ? (after ? "unmute" : "mute") : after ? "mute" : "unmute");
  };
}
