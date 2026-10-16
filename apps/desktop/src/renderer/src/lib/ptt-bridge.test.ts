import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { PttStatus } from "../../../shared/ptt";
import { DEFAULT_SETTINGS, type Settings } from "../../../shared/settings";
import { createPttBridge } from "./ptt-bridge";
import type { VoiceStatus } from "./voice";

function setup(status: PttStatus = "ready") {
  const voice = { store: createStore<{ status: VoiceStatus }>(() => ({ status: "idle" })), setPtt: vi.fn(), setPttHeld: vi.fn() };
  const settings = createStore<{ settings: Settings }>(() => ({ settings: DEFAULT_SETTINGS }));
  let held: (h: boolean) => void = () => undefined;
  const api = { status: vi.fn(async () => status), setRoom: vi.fn(async (_in: boolean) => status), onHeld: (cb: (h: boolean) => void) => ((held = cb), () => undefined) };
  createPttBridge({ api, voice: voice as never, settings });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { voice, settings, api, settle, press: (h: boolean) => held(h) };
}
const pushOn = (s: ReturnType<typeof setup>) => s.settings.setState({ settings: { ...DEFAULT_SETTINGS, pttMode: true, pttKey: "F13" } });

describe("ptt bridge", () => {
  it("forwards the held key to the session", () => {
    const s = setup();
    s.press(true);
    s.press(false);
    expect(s.voice.setPttHeld.mock.calls).toEqual([[true], [false]]);
  });

  it("push-to-talk is in force only with the mode on, a key bound and the hook ready", async () => {
    const s = setup();
    await s.settle();
    expect(s.voice.setPtt).toHaveBeenLastCalledWith(false);
    pushOn(s);
    await s.settle();
    expect(s.voice.setPtt).toHaveBeenLastCalledWith(true);
    s.settings.setState({ settings: { ...DEFAULT_SETTINGS, pttMode: true, pttKey: "" } });
    await s.settle();
    expect(s.voice.setPtt).toHaveBeenLastCalledWith(false);
  });

  it.each<PttStatus>(["unavailable", "permission"])("a hook that is %s falls back to voice activity instead of muting for good", async (status) => {
    const s = setup(status);
    pushOn(s);
    await s.settle();
    expect(s.voice.setPtt).toHaveBeenLastCalledWith(false);
  });

  it("tells the main process when a room starts and ends (the hook runs only inside one)", async () => {
    const s = setup();
    await s.settle();
    expect(s.api.setRoom).toHaveBeenLastCalledWith(false);
    s.voice.store.setState({ status: "requestingToken" });
    s.voice.store.setState({ status: "connecting" }); // still the same room: no new call
    s.voice.store.setState({ status: "connected" });
    expect(s.api.setRoom.mock.calls.map(([v]) => v)).toEqual([false, true]);
    s.voice.store.setState({ status: "idle" });
    expect(s.api.setRoom.mock.calls.map(([v]) => v)).toEqual([false, true, false]);
  });

  it("an older answer that arrives late does not override a newer one", async () => {
    const s = setup();
    let release: (v: PttStatus) => void = () => undefined;
    s.api.setRoom.mockImplementationOnce(() => new Promise<PttStatus>((r) => (release = r)));
    pushOn(s); // first call hangs
    s.api.setRoom.mockResolvedValueOnce("unavailable");
    s.settings.setState({ settings: { ...DEFAULT_SETTINGS, pttMode: true, pttKey: "F14" } });
    await s.settle();
    release("ready");
    await s.settle();
    expect(s.voice.setPtt).toHaveBeenLastCalledWith(false);
  });
});
