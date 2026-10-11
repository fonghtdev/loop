import { describe, expect, it } from "vitest";
import { panelModel } from "./panel-model";

const ch = { kind: "channel", id: "c", name: "test1" } as const;
const dm = { kind: "dm", id: "d", name: "Lan" } as const;

describe("panelModel", () => {
  it("idle and disconnected: strip only", () => {
    expect(panelModel({ status: "idle", target: null, canVideo: true }, false)).toBeNull();
    expect(panelModel({ status: "disconnected", target: ch, canVideo: true }, false)).toBeNull();
  });
  it("connected channel: room button, camera by right, leave", () => {
    expect(panelModel({ status: "connected", target: ch, canVideo: true }, false)).toEqual({ status: "connected", ringing: false, dm: false, camera: true, openRoom: true, leave: "leave" });
    expect(panelModel({ status: "connected", target: ch, canVideo: false }, false)?.camera).toBe(false);
  });
  it("connecting and reconnecting keep the camera disabled", () => {
    expect(panelModel({ status: "requestingToken", target: ch, canVideo: true }, false)).toMatchObject({ status: "connecting", camera: false });
    expect(panelModel({ status: "connecting", target: ch, canVideo: true }, false)?.status).toBe("connecting");
    expect(panelModel({ status: "reconnecting", target: ch, canVideo: true }, false)).toMatchObject({ status: "reconnecting", camera: false });
  });
  it("DM call: hangup, no room button; ringing: cancel", () => {
    expect(panelModel({ status: "connected", target: dm, canVideo: true }, false)).toMatchObject({ dm: true, openRoom: false, leave: "hangup" });
    expect(panelModel({ status: "connected", target: dm, canVideo: true }, true)).toMatchObject({ ringing: true, leave: "cancel" });
  });
});
