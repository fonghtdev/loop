import { describe, expect, it } from "vitest";
import { panelModel } from "./panel-model";

const ch = { kind: "channel", id: "c", name: "test1" } as const;
const dm = { kind: "dm", id: "d", name: "Lan" } as const;

describe("panelModel", () => {
  it("idle and disconnected: strip only", () => {
    expect(panelModel({ status: "idle", target: null, canVideo: true, canStream: true }, false)).toBeNull();
    expect(panelModel({ status: "disconnected", target: ch, canVideo: true, canStream: true }, false)).toBeNull();
  });
  it("connected channel: room button, camera by right, leave", () => {
    expect(panelModel({ status: "connected", target: ch, canVideo: true, canStream: true }, false)).toEqual({ status: "connected", ringing: false, dm: false, camera: true, screen: true, openRoom: true, leave: "leave" });
    expect(panelModel({ status: "connected", target: ch, canVideo: false, canStream: false }, false)?.camera).toBe(false);
  });
  it("screen button follows the right to stream, independent of video", () => {
    expect(panelModel({ status: "connected", target: ch, canVideo: false, canStream: true }, false)).toMatchObject({ camera: false, screen: true });
    expect(panelModel({ status: "connected", target: ch, canVideo: true, canStream: false }, false)).toMatchObject({ camera: true, screen: false });
    expect(panelModel({ status: "reconnecting", target: ch, canVideo: true, canStream: true }, false)?.screen).toBe(false);
  });
  it("connecting and reconnecting keep the camera disabled", () => {
    expect(panelModel({ status: "requestingToken", target: ch, canVideo: true, canStream: true }, false)).toMatchObject({ status: "connecting", camera: false });
    expect(panelModel({ status: "connecting", target: ch, canVideo: true, canStream: true }, false)?.status).toBe("connecting");
    expect(panelModel({ status: "reconnecting", target: ch, canVideo: true, canStream: true }, false)).toMatchObject({ status: "reconnecting", camera: false });
  });
  it("DM call: hangup, no room button; ringing: cancel", () => {
    expect(panelModel({ status: "connected", target: dm, canVideo: true, canStream: true }, false)).toMatchObject({ dm: true, openRoom: false, leave: "hangup" });
    expect(panelModel({ status: "connected", target: dm, canVideo: true, canStream: true }, true)).toMatchObject({ ringing: true, leave: "cancel" });
  });
});
