import { describe, expect, it, vi } from "vitest";
import { audioAllowed, captureShare, createGoLivePrefs, DEFAULT_GOLIVE, FPS_CHOICES, parseGoLive, partitionSources, RESOLUTIONS, streamProfile } from "./golive";

describe("streamProfile", () => {
  // the table the bitrates come from: [resolution, fps, bits/s]
  const TABLE = [
    ["720", 15, 1_500_000],
    ["720", 30, 2_500_000],
    ["720", 60, 4_000_000],
    ["1080", 15, 3_000_000],
    ["1080", 30, 5_000_000],
    ["1080", 60, 8_000_000],
    ["native", 15, 5_000_000],
    ["native", 30, 8_000_000],
    ["native", 60, 12_000_000],
  ] as const;

  it.each(TABLE)("%s @ %i fps publishes at %i bit/s with that frame rate", (resolution, fps, maxBitrate) => {
    expect(streamProfile({ resolution, fps }).publish).toEqual({ maxBitrate, maxFramerate: fps });
    expect(streamProfile({ resolution, fps }).capture.frameRate).toBe(fps);
  });

  it("the table covers every combination", () => {
    expect(TABLE).toHaveLength(RESOLUTIONS.length * FPS_CHOICES.length);
  });

  it("720p and 1080p pin the size; native pins nothing", () => {
    expect(streamProfile({ resolution: "720", fps: 30 }).capture.resolution).toEqual({ width: 1280, height: 720 });
    expect(streamProfile({ resolution: "1080", fps: 30 }).capture.resolution).toEqual({ width: 1920, height: 1080 });
    expect("resolution" in streamProfile({ resolution: "native", fps: 30 }).capture).toBe(false);
  });

  it("detail for 15 and 30 fps, motion for 60", () => {
    expect(FPS_CHOICES.map((fps) => streamProfile({ resolution: "720", fps }).contentHint)).toEqual(["detail", "detail", "motion"]);
  });
});

describe("parseGoLive", () => {
  it("defaults to 720p, 60 fps, sound on", () => {
    expect(DEFAULT_GOLIVE).toEqual({ resolution: "720", fps: 60, audio: true });
    expect(parseGoLive(null)).toEqual(DEFAULT_GOLIVE);
  });

  it("reads a stored value back", () => {
    expect(parseGoLive('{"resolution":"native","fps":15,"audio":false}')).toEqual({ resolution: "native", fps: 15, audio: false });
  });

  it("anything unknown falls back, field by field", () => {
    expect(parseGoLive('{"resolution":"4k","fps":24,"audio":"yes"}')).toEqual(DEFAULT_GOLIVE);
    expect(parseGoLive('{"resolution":"1080","fps":"30"}')).toEqual({ ...DEFAULT_GOLIVE, resolution: "1080" });
    for (const raw of ["", "{", "null", "[]", "7", '"x"']) expect(parseGoLive(raw)).toEqual(DEFAULT_GOLIVE);
  });
});

describe("createGoLivePrefs", () => {
  it("remembers the choice and never a source", () => {
    let stored: string | null = null;
    const prefs = createGoLivePrefs({ storage: { read: () => stored, write: (v) => (stored = v) } });
    expect(prefs.get()).toEqual(DEFAULT_GOLIVE);
    prefs.set({ resolution: "1080", fps: 30, audio: false });
    expect(parseGoLive(stored)).toEqual({ resolution: "1080", fps: 30, audio: false });
    expect(Object.keys(JSON.parse(stored!)).sort()).toEqual(["audio", "fps", "resolution"]);
    expect(createGoLivePrefs({ storage: { read: () => stored, write: () => undefined } }).get()).toEqual({ resolution: "1080", fps: 30, audio: false });
  });

  it("a broken storage means defaults and a lost save, not a crash", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    const prefs = createGoLivePrefs({ storage: { read: boom, write: boom } });
    expect(prefs.get()).toEqual(DEFAULT_GOLIVE);
    prefs.set({ resolution: "native", fps: 15, audio: false });
    expect(prefs.get().resolution).toBe("native");
  });
});

describe("audioAllowed", () => {
  it("only a screen or window on Windows or macOS can carry the system sound", () => {
    for (const platform of ["win32", "darwin"]) expect(audioAllowed("display", platform)).toBe(true);
    expect(audioAllowed("display", "linux")).toBe(false);
    for (const platform of ["win32", "darwin", "linux"]) expect(audioAllowed("device", platform)).toBe(false);
  });
});

describe("partitionSources", () => {
  it("screen: ids are screens, window: ids are windows; anything else is dropped", () => {
    const ids = ["screen:0:0", "window:12:0", "screen:1:0", "other:3", "xscreen:1", ""].map((id) => ({ id }));
    expect(partitionSources(ids)).toEqual({ screens: [{ id: "screen:0:0" }, { id: "screen:1:0" }], windows: [{ id: "window:12:0" }] });
  });
});

describe("captureShare", () => {
  const track = (kind: string) => ({ kind, contentHint: "" }) as unknown as MediaStreamTrack;
  const stream = (audio = false) => ({ getVideoTracks: () => [track("video")], getAudioTracks: () => (audio ? [track("audio")] : []) }) as unknown as MediaStream;
  const make = (audio = false) => {
    const md = { getDisplayMedia: vi.fn(async () => stream(audio)), getUserMedia: vi.fn(async () => stream()) };
    const choose = vi.fn(async () => undefined);
    return { md, choose };
  };

  it("a display: tells main first, then asks for the profile's size and frame rate (and the sound)", async () => {
    const { md, choose } = make(true);
    const tracks = await captureShare(md, choose, { source: { kind: "display", id: "screen:1" }, audio: true }, streamProfile({ resolution: "1080", fps: 30 }));
    expect(choose).toHaveBeenCalledWith("screen:1", { audio: true });
    expect(choose.mock.invocationCallOrder[0]).toBeLessThan(md.getDisplayMedia.mock.invocationCallOrder[0]);
    expect(md.getDisplayMedia).toHaveBeenCalledWith({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: 30 }, audio: true });
    expect(tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
    expect(tracks[0].contentHint).toBe("detail");
  });

  it("native pins no size, only the frame rate", async () => {
    const { md, choose } = make();
    await captureShare(md, choose, { source: { kind: "display", id: "screen:1" }, audio: false }, streamProfile({ resolution: "native", fps: 60 }));
    expect(md.getDisplayMedia).toHaveBeenCalledWith({ video: { frameRate: 60 }, audio: false });
  });

  it("a device is opened by exact id with the profile's constraints; main is not involved and there is no sound", async () => {
    const { md, choose } = make();
    const tracks = await captureShare(md, choose, { source: { kind: "device", deviceId: "cap1" }, audio: true }, streamProfile({ resolution: "720", fps: 60 }));
    expect(md.getUserMedia).toHaveBeenCalledWith({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: 60, deviceId: { exact: "cap1" } } });
    expect(md.getDisplayMedia).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
    expect(tracks.map((t) => t.kind)).toEqual(["video"]);
    expect(tracks[0].contentHint).toBe("motion");
  });
});
