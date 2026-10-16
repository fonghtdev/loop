import type { TrackPublishOptions } from "livekit-client";
import { vi } from "vitest";
import type { AudioSink, AudioTrackLike } from "./audio-sink";
import type { GoLivePrefs, ShareChoice } from "./golive";
import type { NoiseLevel } from "./noise";
import type { TapAudio } from "./speech-level";
import { createVoice, type LocalParticipantLike, type ParticipantLike, type RoomLike } from "./voice";

/** A captured track: only what the voice session touches. */
export class FakeTrack {
  stopped = 0;
  constructor(readonly kind: "video" | "audio") {}
  stop() {
    this.stopped++;
  }
}

/** A stand-in for livekit-client's Room: an event emitter with the few members the voice session uses. */
export class FakeRoom implements RoomLike {
  handlers = new Map<string, ((...a: never[]) => void)[]>();
  disconnected = 0;
  switched: [string, string][] = [];
  connectError: Error | null = null;
  mic: boolean[] = [];
  cam: boolean[] = [];
  published: { track: FakeTrack; options: TrackPublishOptions }[] = [];
  unpublished: FakeTrack[] = [];
  screenFails = false;
  micFails = false;
  micGate: Promise<void> | null = null;
  micOptions: unknown[] = [];
  remoteParticipants = new Map<string, ParticipantLike>();
  metadata: string[] = [];
  localParticipant: LocalParticipantLike = {
    identity: "me",
    name: "Me",
    permissions: { canPublish: true, canPublishSources: [] },
    // like LiveKit: the screen-share publication exists from publish until unpublish
    getTrackPublication: (source: string) => (source === "screen_share" && this.published.some((p) => p.options.source === source && !this.unpublished.includes(p.track)) ? { isMuted: false } : undefined),
    setMicrophoneEnabled: async (on, options) => {
      this.micOptions.push(options);
      await this.micGate;
      if (this.micFails) throw new Error("NotAllowedError");
      this.mic.push(on);
    },
    setCameraEnabled: async (on) => void this.cam.push(on),
    publishTrack: async (track, options) => {
      if (this.screenFails) throw new Error("NotAllowedError");
      this.published.push({ track: track as unknown as FakeTrack, options });
    },
    // like LiveKit: the unpublish is announced with the source of the publication
    unpublishTrack: async (track) => {
      this.unpublished.push(track as unknown as FakeTrack);
      const source = this.published.find((p) => p.track === (track as unknown))?.options.source;
      if (source) this.fire("localTrackUnpublished", { source });
    },
    setMetadata: async (m) => void this.metadata.push(m),
  };
  on(event: string, fn: (...a: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }
  fire(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
  async connect() {
    if (this.connectError) throw this.connectError;
  }
  disconnect() {
    this.disconnected++;
  }
  async switchActiveDevice(kind: string, id: string) {
    this.switched.push([kind, id]);
  }
  addRemote(identity: string, name = identity) {
    const p = { identity, name, getTrackPublication: () => undefined };
    this.remoteParticipants.set(identity, p);
    this.fire("participantConnected", p);
  }
  removeRemote(identity: string) {
    this.remoteParticipants.delete(identity);
    this.fire("participantDisconnected", { identity });
  }
}

export class FakeSink implements AudioSink {
  tracks = new Set<AudioTrackLike>();
  muted = false;
  add(t: AudioTrackLike) {
    this.tracks.add(t);
  }
  remove(t: AudioTrackLike) {
    this.tracks.delete(t);
  }
  setMuted(m: boolean) {
    this.muted = m;
  }
  volumes = new Map<AudioTrackLike, number>();
  setVolume(t: AudioTrackLike, v: number) {
    this.volumes.set(t, v);
  }
  output: string | null = null;
  setOutput(id: string | null) {
    this.output = id;
  }
  clear() {
    this.tracks.clear();
    this.volumes.clear();
    this.muted = false;
  }
}

export const audioTrack = () => ({ kind: "audio", attach: () => document.createElement("audio"), detach: () => undefined }) as never;

/** A stand-in for LocalAudioTrack's processor handling: `processor` is what is attached now. */
export class FakeMicTrack {
  processor: unknown = null;
  restarts: unknown[] = [];
  setFails = false;
  /** `filterOn`: the browser's noiseSuppression of the capture the track started with. */
  constructor(private filterOn = true) {}
  getSourceTrackSettings() {
    return { noiseSuppression: this.filterOn };
  }
  async restartTrack(c: { noiseSuppression: boolean }) {
    this.restarts.push(c);
    this.filterOn = c.noiseSuppression;
  }
  // like LiveKit's: with a processor attached `mediaStreamTrack` is the processor's output, which refuses constraints
  mediaStreamTrack = {
    applyConstraints: async () => {
      if (this.processor) throw new Error("OverconstrainedError: Cannot satisfy constraints");
    },
  };
  async setProcessor(p: unknown) {
    if (this.setFails) throw new Error("worklet failed");
    this.processor = p;
  }
  async stopProcessor() {
    this.processor = null;
  }
}

export function setupVoice(token: Partial<{ canSpeak: boolean; canVideo: boolean; canStream: boolean; url: string; serverMuted: boolean; serverDeafened: boolean }> = {}, onRoom?: (r: FakeRoom) => void) {
  const rooms: FakeRoom[] = [];
  const sink = new FakeSink();
  const request = vi.fn(async (_m: "POST", _p: string, _b?: unknown): Promise<unknown> => ({ token: "tok", url: "ws://lk", canSpeak: true, canVideo: true, canStream: true, ...token }));
  const ensureMedia = vi.fn(async (_k: string) => true);
  const rememberShare = vi.fn<(prefs: GoLivePrefs) => void>();
  const pickScreen = vi.fn(async (): Promise<ShareChoice | null> => ({ source: { kind: "display", id: "screen:1" }, quality: { resolution: "720", fps: 60 }, audio: true, label: "Màn hình" }));
  const captured: FakeTrack[] = [];
  const capture = vi.fn(async (choice: ShareChoice, _profile: unknown) => {
    const tracks = [new FakeTrack("video"), ...(choice.audio ? [new FakeTrack("audio")] : [])];
    captured.push(...tracks);
    return tracks as unknown as MediaStreamTrack[];
  });
  const sounds: [string, boolean][] = [];
  let level: NoiseLevel = "off";
  const processors: { level: NoiseLevel; onFail: (reason?: string) => void }[] = [];
  let clock = 1000;
  const tap = vi.fn<TapAudio>();
  const voice = createVoice({
    request: request as never,
    createRoom: () => {
      const r = new FakeRoom();
      rooms.push(r);
      onRoom?.(r);
      return r;
    },
    sink,
    ensureMedia,
    pickScreen,
    rememberShare,
    capture: capture as never,
    tap,
    noise: { level: () => level, processor: (l, onFail) => (l === "off" ? null : (processors.push({ level: l, onFail }), { name: l } as never)) },
    livekitOrigin: "ws://lk",
    now: () => clock,
    onSound: (kind, deafened) => void sounds.push([kind, deafened]),
  });
  return { voice, tap, rooms, processors, setLevel: (l: NoiseLevel) => (level = l), room: () => rooms[rooms.length - 1], sink, request, ensureMedia, pickScreen, rememberShare, capture, captured, sounds, state: () => voice.store.getState(), tick: (ms: number) => (clock += ms) };
}
