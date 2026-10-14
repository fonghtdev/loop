export const RESOLUTIONS = ["720", "1080", "native"] as const;
export const FPS_CHOICES = [15, 30, 60] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export type Fps = (typeof FPS_CHOICES)[number];
export type Quality = { resolution: Resolution; fps: Fps };
/** What the Go Live dialog remembers (never the source). */
export type GoLivePrefs = Quality & { audio: boolean };
/** Where the picture comes from: a screen or window (id from the main process) or a camera / capture card. */
export type ShareSource = { kind: "display"; id: string } | { kind: "device"; deviceId: string };
export type ShareChoice = { source: ShareSource; quality: Quality; audio: boolean };

export const DEFAULT_GOLIVE: GoLivePrefs = { resolution: "720", fps: 60, audio: true };

// uplink budget (bits/s) per resolution x frame rate; "native" keeps whatever size the source has, so it gets the most
const BITRATE: Record<Resolution, Record<Fps, number>> = {
  "720": { 15: 1_500_000, 30: 2_500_000, 60: 4_000_000 },
  "1080": { 15: 3_000_000, 30: 5_000_000, 60: 8_000_000 },
  native: { 15: 5_000_000, 30: 8_000_000, 60: 12_000_000 },
};
const SIZE = { "720": { width: 1280, height: 720 }, "1080": { width: 1920, height: 1080 } };

/**
 * The capture constraints, the publish encoding and the encoder hint for a quality. "detail" keeps text sharp and drops
 * frames first (15/30 fps); "motion" keeps the frame rate and drops resolution first (60 fps).
 * ponytail: one layer (no simulcast): viewers on a weak link cannot step down, add a low layer if that is reported
 */
export function streamProfile({ resolution, fps }: Quality) {
  return {
    capture: { ...(resolution === "native" ? {} : { resolution: SIZE[resolution] }), frameRate: fps },
    publish: { maxBitrate: BITRATE[resolution][fps], maxFramerate: fps },
    contentHint: fps === 60 ? ("motion" as const) : ("detail" as const),
  };
}
export type StreamProfile = ReturnType<typeof streamProfile>;

/** System sound needs Electron's loopback capture (Windows; macOS 14.2+ through a CoreAudio tap), and a screen / window (a camera has none). */
export const audioAllowed = (kind: ShareSource["kind"], platform: string) => kind === "display" && (platform === "win32" || platform === "darwin");

/** The stored value back into prefs; each field that is not one of the known values falls back on its own. */
export function parseGoLive(raw: string | null): GoLivePrefs {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (parsed && typeof parsed === "object") v = parsed as Record<string, unknown>;
  } catch {
    // a corrupt value: all defaults
  }
  return {
    resolution: RESOLUTIONS.find((r) => r === v.resolution) ?? DEFAULT_GOLIVE.resolution,
    fps: FPS_CHOICES.find((f) => f === v.fps) ?? DEFAULT_GOLIVE.fps,
    audio: typeof v.audio === "boolean" ? v.audio : DEFAULT_GOLIVE.audio,
  };
}

type Deps = { storage: { read(): string | null; write(value: string): void } };

/** The last Go Live choices, kept in localStorage like the device and noise choices (not sensitive). */
export function createGoLivePrefs({ storage }: Deps) {
  let prefs = DEFAULT_GOLIVE;
  try {
    prefs = parseGoLive(storage.read());
  } catch {
    // storage unavailable: the defaults
  }
  return {
    get: () => prefs,
    set(next: GoLivePrefs) {
      prefs = next;
      try {
        storage.write(JSON.stringify(next));
      } catch {
        // a lost preference is harmless
      }
    },
  };
}

type Listed = { id: string };
/** desktopCapturer ids say what a source is: `screen:` a whole display, `window:` an application window. */
export function partitionSources<T extends Listed>(sources: T[]) {
  return { screens: sources.filter((s) => s.id.startsWith("screen:")), windows: sources.filter((s) => s.id.startsWith("window:")) };
}

/** Takes the screen or window stream (constraints from the profile) or a device's, as the tracks to publish: video first, then the sound if there is any. */
export async function captureShare(
  md: Pick<MediaDevices, "getDisplayMedia" | "getUserMedia">,
  choose: (id: string, opts: { audio: boolean }) => Promise<void>,
  { source, audio }: Pick<ShareChoice, "source" | "audio">,
  { capture, contentHint }: StreamProfile,
): Promise<MediaStreamTrack[]> {
  const video = { ...(capture.resolution && { width: { ideal: capture.resolution.width }, height: { ideal: capture.resolution.height } }), frameRate: capture.frameRate };
  let stream: MediaStream;
  if (source.kind === "device") stream = await md.getUserMedia({ video: { ...video, deviceId: { exact: source.deviceId } } });
  else {
    await choose(source.id, { audio });
    stream = await md.getDisplayMedia({ video, audio });
  }
  const [picture] = stream.getVideoTracks();
  picture.contentHint = contentHint;
  return [picture, ...stream.getAudioTracks()];
}
