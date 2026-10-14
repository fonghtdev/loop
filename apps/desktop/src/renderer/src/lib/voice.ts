import { DisconnectReason, Track, type AudioCaptureOptions, type AudioProcessorOptions, type TrackProcessor, type TrackPublishOptions } from "livekit-client";
import { createStore } from "zustand/vanilla";
import { t } from "../i18n/t";
import { isAllowedLivekitUrl } from "../../../shared/url";
import type { AudioSink, AudioTrackLike } from "./audio-sink";
import { errorMessage } from "./errors";
import type { ShareChoice, StreamProfile } from "./golive";
import { streamProfile } from "./golive";
import { noiseConfig, type NoiseLevel } from "./noise";
import type { SoundKind } from "./sounds";
import { encodeDeafened, parseDeafened } from "./voice-flags";
import type { Participant } from "./voice-presence";

/** What a session is joined to: a guild voice channel or a DM call. `name` is for the voice bar. */
export type VoiceTarget = { kind: "channel" | "dm"; id: string; name: string; /** The server of a channel (the panel names it, "Mở phòng thoại" goes there). */ guildId?: string };
/**
 * idle -> requestingToken -> connecting -> connected <-> reconnecting; any state -> idle (left) or
 * disconnected (the server ended it; `reason` + `notice` say why). Both resting states can start a new join.
 */
export type VoiceStatus = "idle" | "requestingToken" | "connecting" | "connected" | "reconnecting" | "disconnected";
/** A session that holds (or is acquiring) a room; the voice panel shows for these. */
export const isActive = (status: VoiceStatus) => status !== "idle" && status !== "disconnected";

/** LiveKit's own rating of our connection (loss, RTT, jitter); `unknown` until it reports. */
export type ConnectionQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

export type VoiceState = {
  status: VoiceStatus;
  quality: ConnectionQuality;
  target: VoiceTarget | null;
  /** Bumps on every join; lets callers tell one session from the next. */
  sessionId: number;
  /** When the room connected (ms), for the call-ended staleness rule. */
  startedAt: number;
  reason: DisconnectReason | null;
  /** A one-line message to show until dismissed (forced disconnect, declined call, ...). */
  notice: string | null;
  canSpeak: boolean;
  canVideo: boolean;
  canStream: boolean;
  /** THE source of truth for the microphone being on (never true unless canSpeak). */
  micEnabled: boolean;
  camEnabled: boolean;
  /** We are sharing the screen (never true unless canStream; follows the OS "Stop sharing" too). */
  screenEnabled: boolean;
  deafened: boolean;
  /** The microphone state to restore on undeafen. */
  micBeforeDeafen: boolean;
  /** Why the mic, camera or screen share could not start (permission denied), shown in the bar. */
  mediaNote: string | null;
  participants: Participant[];
};

// ---- the slice of livekit-client's Room that is used (tests pass a fake) ----
type TrackPublicationLike = { track?: (Participant["video"] & Partial<AudioTrackLike>) | undefined; isMuted: boolean };
export type ParticipantLike = { identity: string; name?: string; metadata?: string; permissions?: { canPublish: boolean; canPublishSources: number[] }; getTrackPublication(source: string): TrackPublicationLike | undefined };
export type LocalParticipantLike = ParticipantLike & {
  setMetadata(metadata: string): Promise<unknown>;
  setMicrophoneEnabled(on: boolean, options?: AudioCaptureOptions): Promise<unknown>;
  setCameraEnabled(on: boolean): Promise<unknown>;
  publishTrack(track: MediaStreamTrack, options: TrackPublishOptions): Promise<unknown>;
  unpublishTrack(track: MediaStreamTrack): Promise<unknown>;
};
export type RoomLike = {
  localParticipant: LocalParticipantLike;
  remoteParticipants: Map<string, ParticipantLike>;
  on(event: string, fn: (...args: never[]) => void): unknown;
  connect(url: string, token: string): Promise<unknown>;
  disconnect(stopTracks?: boolean): unknown;
  /** Moves the live microphone / camera to another device ("default" = the system's). */
  switchActiveDevice(kind: "audioinput" | "videoinput", deviceId: string): Promise<unknown>;
};

/** The slice of LiveKit's LocalAudioTrack the noise level touches. */
type MicTrackLike = { mediaStreamTrack: Pick<MediaStreamTrack, "applyConstraints">; setProcessor(p: NoiseProcessor): Promise<void>; stopProcessor(): Promise<void> };
export type NoiseProcessor = TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>;
/** The microphone cleaning: the chosen level, and the processor for it (null = none; `onFail` is told when it cannot start). */
export type NoiseDeps = { level: () => NoiseLevel; processor: (level: NoiseLevel, onFail: () => void) => NoiseProcessor | null };

type TokenResponse = { token: string; url: string; canSpeak: boolean; canVideo: boolean; canStream: boolean };
type Deps = {
  request: <T>(method: "POST", path: string, body?: unknown) => Promise<T>;
  createRoom: () => RoomLike;
  sink: AudioSink;
  /** The OS-level microphone/camera/screen permission (macOS asks in the main process); false = denied. */
  ensureMedia: (kind: "microphone" | "camera" | "screen") => Promise<boolean>;
  /** The Go Live dialog (source, quality, sound); null = the user cancelled (not an error). */
  pickScreen: () => Promise<ShareChoice | null>;
  /** The tracks of a chosen source at a profile: the picture first, then the sound if there is any. */
  capture: (choice: ShareChoice, profile: StreamProfile) => Promise<MediaStreamTrack[]>;
  noise: NoiseDeps;
  /** The one LiveKit origin the CSP allows. */
  livekitOrigin: string;
  now?: () => number;
  /** A voice-room sound to consider (we only emit changes after the first list; whether it plays is the sounds module's call). */
  onSound?: (kind: SoundKind, deafened: boolean) => void;
};

// LiveKit's TrackSource numbers in a ParticipantPermission
const SOURCE_CAMERA = 1;
const SOURCE_MICROPHONE = 2;
const SOURCE_SCREEN_SHARE = 3;

/** What a (changed) LiveKit permission lets this participant publish. An empty source list means every source. */
export function rightsOf(p?: { canPublish: boolean; canPublishSources: number[] }) {
  if (!p?.canPublish) return { canSpeak: false, canVideo: false, canStream: false };
  const all = p.canPublishSources.length === 0;
  const may = (source: number) => all || p.canPublishSources.includes(source);
  return { canSpeak: may(SOURCE_MICROPHONE), canVideo: may(SOURCE_CAMERA), canStream: may(SOURCE_SCREEN_SHARE) };
}

/** Why the server (or LiveKit) ended a session we did not end ourselves. */
export function disconnectMessage(reason: DisconnectReason | undefined, kind: VoiceTarget["kind"]): string {
  switch (reason) {
    case DisconnectReason.PARTICIPANT_REMOVED:
      return t("voice.disconnected.removed");
    case DisconnectReason.DUPLICATE_IDENTITY:
      return t("voice.disconnected.elsewhere");
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return kind === "dm" ? t("call.ended") : t("voice.disconnected.roomClosed");
    default:
      return t("voice.disconnected.lost");
  }
}

const tokenPath = (target: VoiceTarget) => (target.kind === "channel" ? `/channels/${target.id}/voice/token` : `/dms/${target.id}/call`);
const same = (a: VoiceTarget | null, b: VoiceTarget) => !!a && a.kind === b.kind && a.id === b.id;

const RESET: Omit<VoiceState, "sessionId" | "notice"> = {
  status: "idle",
  quality: "unknown",
  target: null,
  startedAt: 0,
  reason: null,
  canSpeak: false,
  canVideo: false,
  canStream: false,
  micEnabled: false,
  camEnabled: false,
  screenEnabled: false,
  deafened: false,
  micBeforeDeafen: false,
  mediaNote: null,
  participants: [],
};

/**
 * THE voice session: at most one at a time (a channel or a DM call), kept in a vanilla Zustand store; React only
 * reads it. The live Room is owned here and never leaks: every exit path (leave, forced disconnect, sign-out,
 * joining something else) disconnects it and empties the audio sink.
 *
 * Publishing: a participant without SPEAK/VIDEO that tries to publish gets no error, the publish just hangs, so
 * the microphone/camera/screen are only ever started through `setMic`/`setCamera`/`setScreen`, which check `canSpeak`/`canVideo`/`canStream`.
 */
export function createVoice({ request, createRoom, sink, ensureMedia, pickScreen, capture, noise, livekitOrigin, now = Date.now, onSound }: Deps) {
  const store = createStore<VoiceState>(() => ({ ...RESET, sessionId: 0, notice: null }));
  const get = store.getState;
  const set = store.setState;
  let room: RoomLike | null = null;
  let speaking = new Set<string>();
  let session = 0;
  // Who is in the room, for join/leave sounds. null = not listening: while connecting (the initial list is silent) and
  // while reconnecting (LiveKit re-announces everyone); on (re)connect it is re-read, so nobody there already sounds.
  let known: Set<string> | null = null;
  const sound = (kind: SoundKind) => onSound?.(kind, get().deafened);
  const sessionEnding = () => {
    const { status } = get();
    if (status === "connected" || status === "reconnecting") sound("selfLeave");
  };
  const active = (id: number) => id === session;

  const toParticipant = (p: ParticipantLike, isLocal: boolean): Participant => {
    const cam = p.getTrackPublication("camera");
    const mic = p.getTrackPublication("microphone");
    const screen = p.getTrackPublication("screen_share");
    // someone who may not speak has no microphone state to show; for everyone else a missing or muted track is "mic off"
    const micOff = rightsOf(p.permissions ?? { canPublish: true, canPublishSources: [] }).canSpeak && (!mic || mic.isMuted);
    return { userId: p.identity, username: p.name || p.identity, isLocal, speaking: speaking.has(p.identity), video: cam?.track && !cam.isMuted ? cam.track : undefined, screen: screen?.track && !screen.isMuted ? screen.track : undefined, sharing: !!screen, micOff, deafened: parseDeafened(p.metadata) };
  };
  const refresh = () => {
    if (!room) return;
    set({ participants: [toParticipant(room.localParticipant, true), ...[...room.remoteParticipants.values()].map((p) => toParticipant(p, false))] });
  };

  /** Drops the room and everything hanging off it; the caller sets the next state. */
  function release() {
    const r = room;
    room = null;
    speaking = new Set();
    known = null;
    sink.clear();
    stopShared();
    if (r) void Promise.resolve(r.disconnect()).catch(() => undefined);
  }

  // Mic, camera and screen changes run one after another: the intended state is set at once (so a quick second click
  // toggles from what the user sees) and the queue brings LiveKit to the latest intention in order. Without it a
  // mute during the first publish finds nothing to mute yet and is lost.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = (job: () => Promise<void>) => (queue = queue.then(job).catch(() => undefined));

  type Device = { key: "micEnabled" | "camEnabled"; allowed: "canSpeak" | "canVideo"; kind: "microphone" | "camera"; osDenied: Parameters<typeof t>[0]; denied: Parameters<typeof t>[0]; apply: (r: RoomLike, on: boolean) => Promise<unknown> };
  const noiseFailed = () => set({ mediaNote: t("voice.media.noiseFailed") });
  /** How a NEW microphone track is captured at the current level (an existing one keeps what it has; `applyNoise` moves it). */
  const micCapture = (): AudioCaptureOptions => {
    const level = noise.level();
    return { noiseSuppression: noiseConfig(level).browserNoiseSuppression, processor: noise.processor(level, noiseFailed) ?? undefined };
  };
  const MIC: Device = { key: "micEnabled", allowed: "canSpeak", kind: "microphone", osDenied: "voice.media.micOsDenied", denied: "voice.media.micDenied", apply: (r, on) => r.localParticipant.setMicrophoneEnabled(on, on ? micCapture() : undefined) };
  const CAM: Device = { key: "camEnabled", allowed: "canVideo", kind: "camera", osDenied: "voice.media.camOsDenied", denied: "voice.media.camDenied", apply: (r, on) => r.localParticipant.setCameraEnabled(on) };

  function setDevice(d: Device, on: boolean) {
    if (!room || (on && !get()[d.allowed])) return Promise.resolve(); // never publish without the right (the publish would hang)
    const id = session;
    set({ [d.key]: on, mediaNote: null });
    return serial(async () => {
      const r = room;
      if (!r || !active(id)) return;
      const want = get()[d.key];
      const fail = (note?: Parameters<typeof t>[0]) => {
        if (active(id) && get()[d.key] === want) set({ [d.key]: false, mediaNote: note ? t(note) : null });
      };
      if (want && !(await ensureMedia(d.kind))) return fail(d.osDenied);
      if (!active(id)) return;
      try {
        await d.apply(r, want);
      } catch {
        fail(d.denied);
      }
      if (active(id)) refresh();
    });
  }
  const setMic = (on: boolean) => setDevice(MIC, on);
  const setCamera = (on: boolean) => setDevice(CAM, on);

  // The tracks of the running screen share. They are ours (raw MediaStreamTracks), so LiveKit does not stop them: whoever
  // ends the share must (otherwise the capture, and a camera's light, would stay on).
  let shared: MediaStreamTrack[] = [];
  const stopShared = () => shared.splice(0).forEach((track) => track.stop());
  async function unshare(r: RoomLike) {
    const old = shared.splice(0);
    await Promise.all(old.map((track) => r.localParticipant.unpublishTrack(track).catch(() => undefined)));
    old.forEach((track) => track.stop());
  }

  /**
   * Go Live: asks which source, quality and sound, then publishes it as the screen share. One source at a time: with a
   * share running, the old one is stopped only after the user confirmed a new one in the same session (cancelling
   * keeps the running share). Cancelling is not an error.
   */
  function startScreen() {
    if (!room || !get().canStream) return Promise.resolve(); // never publish without the right (the publish would hang)
    const id = session;
    set({ mediaNote: null });
    return serial(async () => {
      const r = room;
      if (!r || !active(id)) return;
      const choice = await pickScreen();
      if (!choice || !active(id)) return;
      const camera = choice.source.kind === "device";
      const allowed = await ensureMedia(camera ? "camera" : "screen");
      if (!active(id)) return;
      if (!allowed) return set({ mediaNote: t(camera ? "voice.media.camOsDenied" : "voice.media.screenOsDenied") });
      await unshare(r);
      set({ screenEnabled: true });
      try {
        const profile = streamProfile(choice.quality);
        const tracks = (shared = await capture(choice, profile));
        for (const track of tracks) {
          const video = track.kind === "video";
          await r.localParticipant.publishTrack(track, video ? { source: Track.Source.ScreenShare, screenShareEncoding: profile.publish, simulcast: false } : { source: Track.Source.ScreenShareAudio });
        }
      } catch {
        await unshare(r);
        if (active(id)) set({ screenEnabled: false, mediaNote: t(camera ? "voice.media.camDenied" : "voice.media.screenDenied") });
      }
      if (active(id)) refresh();
    });
  }
  function stopScreen() {
    const id = session;
    if (!room || !get().screenEnabled) return Promise.resolve();
    set({ screenEnabled: false, mediaNote: null });
    return serial(async () => {
      if (room && active(id)) await unshare(room);
    });
  }

  /**
   * Brings the live microphone to the current noise level (processor on/off, the browser's filter off while RNNoise
   * runs). Never touches `micEnabled`; a muted mic is moved too, and no mic yet = the next capture uses the level.
   * A failure leaves the browser's filter on, unprocessed, with a note: the mic keeps working.
   */
  async function moveNoise() {
    const track = room?.localParticipant.getTrackPublication("microphone")?.track as Partial<MicTrackLike> | undefined;
    if (!track?.setProcessor || !track.stopProcessor || !track.mediaStreamTrack) return;
    const id = session;
    const level = noise.level();
    try {
      const p = noise.processor(level, noiseFailed);
      if (p) await track.setProcessor(p);
      else await track.stopProcessor();
      await track.mediaStreamTrack.applyConstraints({ noiseSuppression: noiseConfig(level).browserNoiseSuppression });
    } catch {
      await track.stopProcessor().catch(() => undefined);
      await track.mediaStreamTrack.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
      if (active(id)) noiseFailed();
    }
  }

  /** The server changed what we may publish (e.g. SPEAK revoked): controls follow, LiveKit already stopped the tracks. */
  function applyRights({ canSpeak, canVideo, canStream }: { canSpeak: boolean; canVideo: boolean; canStream: boolean }) {
    const s = get();
    set({
      canSpeak,
      canVideo,
      canStream,
      micEnabled: s.micEnabled && canSpeak,
      micBeforeDeafen: s.micBeforeDeafen && canSpeak,
      camEnabled: s.camEnabled && canVideo,
      screenEnabled: s.screenEnabled && canStream,
    });
    if (!canStream) stopShared();
    refresh();
  }

  function wire(r: RoomLike, id: number) {
    const on = (event: string, fn: (...args: never[]) => void) => r.on(event, ((...args: never[]) => active(id) && fn(...args)) as never);
    on("connectionQualityChanged", (quality: ConnectionQuality, p: { identity: string }) => {
      if (p.identity === r.localParticipant.identity) set({ quality });
    });
    on("reconnecting", () => {
      known = null;
      set({ status: "reconnecting" });
    });
    on("reconnected", () => {
      known = new Set(r.remoteParticipants.keys());
      set({ status: "connected" });
      refresh();
    });
    on("disconnected", (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.CLIENT_INITIATED) return;
      const kind = get().target?.kind ?? "channel";
      sessionEnding();
      release();
      set({ ...RESET, status: "disconnected", reason: reason ?? DisconnectReason.UNKNOWN_REASON, notice: disconnectMessage(reason, kind) });
    });
    on("activeSpeakersChanged", (list: { identity: string }[]) => {
      speaking = new Set(list.map((p) => p.identity));
      refresh();
    });
    on("trackSubscribed", (track: { kind: string } & AudioTrackLike) => {
      if (track.kind === "audio") sink.add(track);
      refresh();
    });
    on("trackUnsubscribed", (track: { kind: string } & AudioTrackLike) => {
      if (track.kind === "audio") sink.remove(track);
      refresh();
    });
    on("participantPermissionsChanged", (_prev: unknown, p: { identity: string }) => {
      if (p.identity === r.localParticipant.identity) applyRights(rightsOf(r.localParticipant.permissions));
    });
    on("participantConnected", (p: { identity: string }) => {
      refresh();
      if (known && !known.has(p.identity)) {
        known.add(p.identity);
        sound("join");
      }
    });
    on("participantDisconnected", (p: { identity: string }) => {
      refresh();
      if (known?.delete(p.identity)) sound("leave");
    });
    // the OS "Stop sharing" button (or a revoked right) ends the track without us asking: the button follows
    on("localTrackUnpublished", (pub: { source: string }) => {
      if (pub.source === "screen_share") {
        set({ screenEnabled: false });
        void unshare(r); // the picture ended on its own: the sound track of the share goes too
      }
      refresh();
    });
    for (const e of ["participantMetadataChanged", "trackMuted", "trackUnmuted", "localTrackPublished", "trackPublished", "trackUnpublished"])
      on(e, refresh);
  }

  /** Tells the others (cosmetically, see voice-flags) whether we are deafened; a refusal (older server) is harmless. */
  const publishDeafened = (on: boolean) => void room?.localParticipant.setMetadata(encodeDeafened(on)).catch(() => undefined);

  function leave() {
    if (get().status === "idle") return;
    sessionEnding();
    session++;
    release();
    set({ ...RESET });
  }

  function fail(id: number, message: string) {
    if (!active(id)) return;
    release();
    set({ ...RESET, status: "disconnected", notice: message });
  }

  /** Joins a channel or call; leaves whatever session is running first. Resolves true once connected. */
  async function join(target: VoiceTarget, { video = false }: { video?: boolean } = {}): Promise<boolean> {
    const s = get();
    if (same(s.target, target) && ["requestingToken", "connecting", "connected", "reconnecting"].includes(s.status)) return s.status === "connected";
    leave();
    const id = ++session;
    set({ ...RESET, status: "requestingToken", target, sessionId: id, notice: null });
    let tok: TokenResponse;
    try {
      tok = await request<TokenResponse>("POST", tokenPath(target), target.kind === "dm" ? { video } : undefined);
    } catch (e) {
      fail(id, errorMessage(e));
      return false;
    }
    if (!active(id)) return false;
    if (!isAllowedLivekitUrl(tok.url, livekitOrigin)) {
      fail(id, t("voice.errors.origin"));
      return false;
    }
    set({ status: "connecting", canSpeak: tok.canSpeak, canVideo: tok.canVideo, canStream: tok.canStream });
    const r = createRoom();
    room = r;
    wire(r, id);
    try {
      await r.connect(tok.url, tok.token);
    } catch {
      if (!active(id)) return false; // left while connecting
      fail(id, t("voice.errors.connect"));
      return false;
    }
    if (!active(id)) return false;
    set({ status: "connected", startedAt: now() });
    known = new Set(r.remoteParticipants.keys());
    sound("selfJoin");
    refresh();
    await setMic(true);
    if (video) await setCamera(true);
    return active(id);
  }

  return {
    store,
    join,
    joinChannel: (id: string, name: string, guildId?: string) => join({ kind: "channel", id, name, guildId }),
    joinDm: (id: string, name: string, video: boolean) => join({ kind: "dm", id, name }, { video }),
    leave,
    toggleMic: async () => {
      const s = get();
      if (!s.deafened) await setMic(!s.micEnabled);
    },
    toggleCamera: () => setCamera(!get().camEnabled),
    startScreen,
    stopScreen,
    toggleScreen: () => (get().screenEnabled ? stopScreen() : startScreen()),
    /** Deafen silences every remote <audio> (nothing is unsubscribed) and the mic; undeafen restores the mic as it was. */
    async toggleDeafen() {
      const s = get();
      if (!room) return;
      if (!s.deafened) {
        sink.setMuted(true);
        set({ deafened: true, micBeforeDeafen: s.micEnabled });
        publishDeafened(true);
        if (s.micEnabled) await setMic(false);
      } else {
        sink.setMuted(false);
        publishDeafened(false);
        const restore = s.micBeforeDeafen;
        set({ deafened: false, micBeforeDeafen: false });
        if (restore) await setMic(true);
      }
    },
    /** The live session follows a device change in settings (no session: nothing to move; the next join uses the choice). */
    // queued behind the mic / camera jobs: switching while the first publish is still opening the old device would be lost
    switchDevice: (kind: "audioinput" | "videoinput", deviceId: string) => {
      const r = room;
      return serial(async () => {
        await r?.switchActiveDevice(kind, deviceId);
        if (kind === "audioinput") await moveNoise(); // the new capture starts from the constraints of the first one
      });
    },
    /** The noise level changed in settings: the live session follows at once (queued behind mic jobs, like a device change). */
    applyNoise: () => serial(moveNoise),
    notify: (notice: string) => set({ notice }),
    dismissNotice: () => set({ notice: null }),
  };
}
export type Voice = ReturnType<typeof createVoice>;
