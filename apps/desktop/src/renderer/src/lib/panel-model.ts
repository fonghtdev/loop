import { isActive, type VoiceState } from "./voice";

/** What the bottom panel's call header shows for a session; null = no session, only the account strip. */
export type PanelModel = {
  status: "connecting" | "connected" | "reconnecting";
  ringing: boolean;
  dm: boolean;
  /** The camera button works (connected, and the right to publish video). */
  camera: boolean;
  /** The screen-share button works (connected, and the right to stream). */
  screen: boolean;
  /** "Mở phòng thoại" exists for a voice channel only (a DM call is already in its conversation). */
  openRoom: boolean;
  leave: "leave" | "hangup" | "cancel";
};

export function panelModel(v: Pick<VoiceState, "status" | "target" | "canVideo" | "canStream">, ringing: boolean): PanelModel | null {
  if (!isActive(v.status) || !v.target) return null;
  const dm = v.target.kind === "dm";
  const status = v.status === "reconnecting" ? "reconnecting" : v.status === "connected" ? "connected" : "connecting";
  return { status, ringing, dm, camera: status === "connected" && v.canVideo, screen: status === "connected" && v.canStream, openRoom: !dm, leave: ringing ? "cancel" : dm ? "hangup" : "leave" };
}
