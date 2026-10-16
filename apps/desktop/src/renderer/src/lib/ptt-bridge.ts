import type { StoreApi } from "zustand/vanilla";
import type { PttStatus } from "../../../shared/ptt";
import type { Settings } from "../../../shared/settings";
import { isActive, type Voice } from "./voice";

type Api = { status(): Promise<PttStatus>; setRoom(inRoom: boolean): Promise<PttStatus>; onHeld(cb: (held: boolean) => void): () => void };

/**
 * Joins the main process's key hook to the voice session. The hook runs only while we are in a room, so the room state
 * goes over (`setRoom`) and the answer says whether push-to-talk can work here; if it cannot (module missing, macOS
 * permission), the session stays on voice activity instead of leaving the user muted for good.
 */
export function createPttBridge({ api, voice, settings }: { api: Api; voice: Pick<Voice, "store" | "setPtt" | "setPttHeld">; settings: StoreApi<{ settings: Settings }> }) {
  let latest = 0;
  async function sync() {
    const mine = ++latest;
    const status = await api.setRoom(isActive(voice.store.getState().status)).catch(() => "unavailable" as const);
    if (mine !== latest) return; // a newer change is already on its way
    const { pttMode, pttKey } = settings.getState().settings;
    voice.setPtt(pttMode && !!pttKey && status === "ready");
  }
  api.onHeld(voice.setPttHeld);
  voice.store.subscribe((s, prev) => isActive(s.status) !== isActive(prev.status) && void sync());
  settings.subscribe((s, prev) => (s.settings.pttMode !== prev.settings.pttMode || s.settings.pttKey !== prev.settings.pttKey) && void sync());
  void sync();
  return { sync };
}
