import type { ShortcutAction } from "../../../shared/shortcut";
import type { Voice } from "./voice";

/**
 * A global shortcut flips the mic or the hearing of the live session, through the same voice calls as the buttons (so the
 * canSpeak / deafen rules and the job queue apply). Outside a connected session it is ignored. The confirming beep is the
 * voice session's own (toggleMic / toggleDeafen), so the buttons and the shortcut sound the same.
 */
export function createShortcutHandler({ store, toggleMic, toggleDeafen }: Pick<Voice, "store" | "toggleMic" | "toggleDeafen">) {
  return async (action: ShortcutAction) => {
    if (store.getState().status !== "connected") return;
    await (action === "mic" ? toggleMic() : toggleDeafen());
  };
}
