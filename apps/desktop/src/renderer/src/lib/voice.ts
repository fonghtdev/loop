import { DisconnectReason, Track, type AudioCaptureOptions, type AudioProcessorOptions, type TrackProcessor, type TrackPublishOptions } from "livekit-client";
import { createStore } from "zustand/vanilla";
import { t } from "../i18n/t";
import { isAllowedLivekitUrl } from "../../../shared/url";
import type { AudioSink, AudioTrackLike } from "./audio-sink";
import { errorMessage } from "./errors";
import type { GoLivePrefs, Quality, ShareChoice, StreamProfile } from "./golive";
import { screenPublishOptions, streamProfile } from "./golive";
import { micLive } from "./mic-gate";
import { clampVolume, effectiveVolume, pruneWatching, subscriptionChanges } from "./stream-watch";
import { MAX_USER_VOLUME, type UserVolumes } from "./voice-volume";
import { noiseConfig, reasonOf, type NoiseLevel } from "./noise";
import { createSpeechDetector, type LevelProbe, type TapAudio } from "./speech-level";
import type { SoundKind } from "./sounds";
import { encodeFlags, parseFlags } from "./voice-flags";
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
  /** What the running share is (source, quality, sound, name for the panel card); null exactly when `screenEnabled` is false. */
  stream: ShareChoice | null;
  deafened: boolean;
  /** A moderator's server mute / deafen of us in this channel (token, then `voice:moderated`); LiveKit enforces it, this explains it. */
  serverMuted: boolean;
  serverDeafened: boolean;
  /** The microphone state to restore on undeafen. */
  micBeforeDeafen: boolean;
  /** Why the mic, camera or screen share could not start (permission denied), shown in the bar. */
  mediaNote: string | null;
  participants: Participant[];
  /** Whose screen share we chose to watch (nothing is downloaded or played for the others). Per session, not persisted. */
  watching: string[];
  /** Per sharer, the viewer's own slider (0..1, default 1) and mute for that stream's sound; kept while the session lasts. */
  streamVolume: Record<string, number>;
  streamMuted: Record<string, boolean>;
  /** Push-to-talk is in force (set from the settings by ptt-bridge, kept across sessions): the mic transmits only while `pttHeld`. */
  ptt: boolean;
  /** The push-to-talk key is down right now (reset with the session). */
  pttHeld: boolean;
};

// ---- the slice of livekit-client's Room that is used (tests pass a fake) ----
type TrackPublicationLike = { track?: (Participant["video"] & Partial<AudioTrackLike> & { mediaStreamTrack?: MediaStreamTrack }) | undefined; isMuted: boolean; /** Remote publications only. */ isSubscribed?: boolean; setSubscribed?(subscribed: boolean): void };
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
// LiveKit: `mediaStreamTrack` is the processor's OUTPUT while one is attached and refuses constraints, so the browser's filter is
// read from the source track and changed only by a new capture (`restartTrack`).
type MicTrackLike = { getSourceTrackSettings(): MediaTrackSettings; restartTrack(constraints: { noiseSuppression: boolean }): Promise<void>; setProcessor(p: NoiseProcessor): Promise<void>; stopProcessor(): Promise<void> };
export type NoiseProcessor = TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>;
/** The microphone cleaning: the chosen level, and the processor for it (null = none; `onFail` is told when it cannot start). */
export type NoiseDeps = { level: () => NoiseLevel; processor: (level: NoiseLevel, onFail: (reason?: string) => void) => NoiseProcessor | null };

type TokenResponse = { token: string; url: string; canSpeak: boolean; canVideo: boolean; canStream: boolean; serverMuted?: boolean; serverDeafened?: boolean };
type Deps = {
  request: <T>(method: "POST", path: string, body?: unknown) => Promise<T>;
  createRoom: () => RoomLike;
  sink: AudioSink;
  /** Each other person's own loudness and mute-for-me (per account, persisted); the room only reads it and writes the user's changes. */
  userVolumes: UserVolumes;
  /** The OS-level microphone/camera/screen permission (macOS asks in the main process); false = denied. */
  ensureMedia: (kind: "microphone" | "camera" | "screen") => Promise<boolean>;
  /** The Go Live dialog (source, quality, sound); null = the user cancelled (not an error). */
  pickScreen: () => Promise<ShareChoice | null>;
  /** The tracks of a chosen source at a profile: the picture first, then the sound if there is any. */
  capture: (choice: ShareChoice, profile: StreamProfile) => Promise<MediaStreamTrack[]>;
  /** Remembers the quality and sound a live change settled on (the Go Live dialog's own memory). */
  rememberShare: (prefs: GoLivePrefs) => void;
  noise: NoiseDeps;
  /** Measures a microphone track locally for an instant speaking ring; without it only LiveKit's own flag is used. */
  tap?: TapAudio;
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

const RESET: Omit<VoiceState, "sessionId" | "notice" | "ptt"> = {
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
  stream: null,
  deafened: false,
  serverMuted: false,
  serverDeafened: false,
  micBeforeDeafen: false,
  mediaNote: null,
  participants: [],
  watching: [],
  streamVolume: {},
  streamMuted: {},
  pttHeld: false,
};

/**
 * THE voice session: at most one at a time (a channel or a DM call), kept in a vanilla Zustand store; React only
 * reads it. The live Room is owned here and never leaks: every exit path (leave, forced disconnect, sign-out,
 * joining something else) disconnects it and empties the audio sink.
 *
 * Publishing: a participant without SPEAK/VIDEO that tries to publish gets no error, the publish just hangs, so
 * the microphone/camera/screen are only ever started through `setMic`/`setCamera`/`setScreen`, which check `canSpeak`/`canVideo`/`canStream`.
 */
export function createVoice({ request, createRoom, sink, userVolumes, ensureMedia, pickScreen, capture, rememberShare, noise, tap, livekitOrigin, now = Date.now, onSound }: Deps) {
  const store = createStore<VoiceState>(() => ({ ...RESET, sessionId: 0, notice: null, ptt: false }));
  const get = store.getState;
  const set = store.setState;
  let room: RoomLike | null = null;
  let speaking = new Set<string>();
  // Who is speaking by our own measurement (LiveKit's flag arrives a second or two late); OR-ed with `speaking`.
  let measured = new Set<string>();
  let session = 0;
  // Who is in the room, for join/leave sounds. null = not listening: while connecting (the initial list is silent) and
  // while reconnecting (LiveKit re-announces everyone); on (re)connect it is re-read, so nobody there already sounds.
  let known: Set<string> | null = null;
  const sound = (kind: SoundKind, deafened = get().deafened) => onSound?.(kind, deafened);
  // Who shares a screen right now, for the stream sounds. null = not listening (same rule as `known`): the first list after
  // (re)connecting is the baseline, so joining a room where someone is live is silent.
  let liveSharers: Set<string> | null = null;
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
    const flags = parseFlags(p.metadata);
    return { userId: p.identity, username: p.name || p.identity, isLocal, speaking: speaking.has(p.identity) || measured.has(p.identity), video: cam?.track && !cam.isMuted ? cam.track : undefined, screen: screen?.track && !screen.isMuted ? screen.track : undefined, sharing: !!screen, micOff, deafened: flags.deafened, watching: flags.watching };
  };
  /** One sound per share that really started / ended since the last look. Our own share stays "on" while a quality / source change re-captures it. */
  const streamSounds = (participants: Participant[]) => {
    if (!known) {
      liveSharers = null;
      return;
    }
    const before = liveSharers;
    const current = new Set(participants.filter((p) => p.sharing || (p.isLocal && !!before?.has(p.userId) && get().screenEnabled)).map((p) => p.userId));
    if (before) {
      for (const id of current) if (!before.has(id)) sound("streamStart");
      // someone who left ends their share by leaving: that is the leave sound's job
      for (const id of before) if (!current.has(id) && participants.some((p) => p.userId === id)) sound("streamStop");
    }
    liveSharers = current;
  };
  const refresh = () => {
    if (!room) return;
    const remotes = [...room.remoteParticipants.values()];
    const participants = [toParticipant(room.localParticipant, true), ...remotes.map((p) => toParticipant(p, false))];
    const sharers = new Set(participants.filter((p) => !p.isLocal && p.sharing).map((p) => p.userId));
    streamSounds(participants);
    set({ participants, watching: pruneWatching(get().watching, sharers) });
  };

  // ---- watching screen shares: the ONE place that decides what is subscribed ----
  // A stream's picture and sound are subscribed only while its owner is in `watching`; mic and camera stay on LiveKit's
  // auto-subscribe. A fresh publication may be auto-subscribed for a moment before the next sync drops it.
  const streamAudio = new Map<string, AudioTrackLike>();
  const streamGain = (userId: string) => {
    const s = get();
    return s.watching.includes(userId) ? effectiveVolume(s.deafened, !!s.streamMuted[userId], s.streamVolume[userId] ?? 1) : 0;
  };
  const applyStreamAudio = () => streamAudio.forEach((track, userId) => sink.setVolume(track, streamGain(userId)));
  // Each other person's MICROPHONE sound: their slider (0..200%) and mute-for-me from `userVolumes`, silenced by our deafen.
  const micAudio = new Map<string, AudioTrackLike>();
  const micGain = (userId: string) => {
    const { volume, muted } = userVolumes.get(userId);
    return effectiveVolume(get().deafened, muted, volume, MAX_USER_VOLUME);
  };
  const applyMicAudio = () => micAudio.forEach((track, userId) => sink.setVolume(track, micGain(userId)));
  const syncStreams = () => {
    if (!room) return;
    const pubs = [...room.remoteParticipants.values()].flatMap((p) =>
      [Track.Source.ScreenShare, Track.Source.ScreenShareAudio].flatMap((source) => {
        const pub = p.getTrackPublication(source);
        return pub?.setSubscribed ? [{ userId: p.identity, source: source as string, subscribed: !!pub.isSubscribed, pub }] : [];
      }),
    );
    for (const { pub, subscribe } of subscriptionChanges(get().watching, pubs)) pub.setSubscribed?.(subscribe);
    applyStreamAudio();
  };
  const publicationsChanged = () => {
    refresh();
    syncStreams();
  };

  // ---- local speaking detection: one analyser per audible microphone, sampled every METER_MS ----
  // ponytail: thresholds in speech-level.ts are a guess; analysis is capped at the room limit (25 people).
  const METER_MS = 50;
  const METER_MAX = 25;
  type Tap = { track: MediaStreamTrack; probe: LevelProbe; detect: ReturnType<typeof createSpeechDetector> };
  const taps = new Map<string, Tap>();
  let meterTimer: ReturnType<typeof setInterval> | null = null;
  const closeTap = (id: string) => {
    taps.get(id)?.probe.close();
    taps.delete(id);
  };
  function meterTick() {
    if (!room || !tap) return;
    const at = now();
    const next = new Set<string>();
    const present = new Set<string>();
    for (const p of [room.localParticipant, ...room.remoteParticipants.values()].slice(0, METER_MAX)) {
      const pub = p.getTrackPublication("microphone");
      const track = pub?.track?.mediaStreamTrack;
      // a muted, unsubscribed or (for us) switched-off microphone is never measured
      if (!track || pub.isMuted || (p === room.localParticipant && !get().micEnabled)) continue;
      present.add(p.identity);
      let entry = taps.get(p.identity);
      if (entry?.track !== track) {
        closeTap(p.identity);
        entry = { track, probe: tap(track) ?? { read: () => -Infinity, close: () => undefined }, detect: createSpeechDetector() };
        taps.set(p.identity, entry);
      }
      if (entry.detect(entry.probe.read(), at)) next.add(p.identity);
    }
    for (const id of [...taps.keys()]) if (!present.has(id)) closeTap(id);
    if (next.size === measured.size && [...next].every((id) => measured.has(id))) return; // store untouched unless someone flipped
    measured = next;
    refresh();
  }
  const startMeter = () => {
    if (tap && !meterTimer) meterTimer = setInterval(meterTick, METER_MS);
  };
  function stopMeter() {
    if (meterTimer) clearInterval(meterTimer);
    meterTimer = null;
    for (const id of [...taps.keys()]) closeTap(id);
    measured = new Set();
  }

  /** Drops the room and everything hanging off it; the caller sets the next state. */
  function release() {
    const r = room;
    room = null;
    speaking = new Set();
    stopMeter();
    known = null;
    liveSharers = null;
    sink.clear();
    streamAudio.clear();
    micAudio.clear();
    stopShared();
    if (r) void Promise.resolve(r.disconnect()).catch(() => undefined);
  }

  // Mic, camera and screen changes run one after another: the intended state is set at once (so a quick second click
  // toggles from what the user sees) and the queue brings LiveKit to the latest intention in order. Without it a
  // mute during the first publish finds nothing to mute yet and is lost.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = (job: () => Promise<void>) => (queue = queue.then(job).catch(() => undefined));

  type Device = { key: "micEnabled" | "camEnabled"; allowed: "canSpeak" | "canVideo"; /** What the device should be doing now (the mic follows push-to-talk, the camera its switch). */ wanted: (s: VoiceState) => boolean; kind: "microphone" | "camera"; osDenied: Parameters<typeof t>[0]; denied: Parameters<typeof t>[0]; apply: (r: RoomLike, on: boolean) => Promise<unknown> };
  const noiseFailed = (reason?: string) => set({ mediaNote: t("voice.media.noiseFailed") + (reason ? ` (${reason})` : "") });
  /** How a NEW microphone track is captured at the current level (an existing one keeps what it has; `applyNoise` moves it). */
  const micCapture = (): AudioCaptureOptions => {
    const level = noise.level();
    return { noiseSuppression: noiseConfig(level).browserNoiseSuppression, processor: noise.processor(level, noiseFailed) ?? undefined };
  };
  const MIC: Device = { key: "micEnabled", allowed: "canSpeak", wanted: micLive, kind: "microphone", osDenied: "voice.media.micOsDenied", denied: "voice.media.micDenied", apply: (r, on) => r.localParticipant.setMicrophoneEnabled(on, on ? micCapture() : undefined) };
  const CAM: Device = { key: "camEnabled", allowed: "canVideo", wanted: (s) => s.camEnabled, kind: "camera", osDenied: "voice.media.camOsDenied", denied: "voice.media.camDenied", apply: (r, on) => r.localParticipant.setCameraEnabled(on) };

  function setDevice(d: Device, on: boolean) {
    if (!room || (on && !get()[d.allowed])) return Promise.resolve(); // never publish without the right (the publish would hang)
    set({ [d.key]: on, mediaNote: null });
    return applyDevice(d);
  }
  /** Brings LiveKit to what the device should be doing now (queued; the intention itself is already in the store). */
  function applyDevice(d: Device) {
    const id = session;
    return serial(async () => {
      const r = room;
      if (!r || !active(id)) return;
      const want = d.wanted(get());
      const fail = (note?: Parameters<typeof t>[0]) => {
        if (active(id) && d.wanted(get()) === want) set({ [d.key]: false, mediaNote: note ? t(note) : null });
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
  // true while a share is being replaced by its successor: LiveKit announces the old picture's end, which is not "the share stopped"
  let swapping = false;
  const SHARE_OFF = { screenEnabled: false, stream: null };
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
      await goLive(r, id, choice);
    });
  }
  /** Replaces the running share (if any) with `choice`: the old tracks go first, so there is never more than one share published. */
  async function goLive(r: RoomLike, id: number, choice: ShareChoice) {
    swapping = true;
    try {
      await unshare(r);
    } finally {
      swapping = false;
    }
    set({ screenEnabled: true, stream: choice });
    try {
      const profile = streamProfile(choice.quality);
      const tracks = (shared = await capture(choice, profile));
      for (const track of tracks) {
        const video = track.kind === "video";
        await r.localParticipant.publishTrack(track, video ? screenPublishOptions(profile) : { source: Track.Source.ScreenShareAudio });
      }
    } catch {
      await unshare(r);
      if (active(id)) set({ ...SHARE_OFF, mediaNote: t(choice.source.kind === "device" ? "voice.media.camDenied" : "voice.media.screenDenied") });
    }
    if (active(id)) refresh();
  }
  /**
   * Changes the quality or the sound of the running share while keeping its source: the same source is captured again
   * (the main process answers one getDisplayMedia per `choose`, and `capture` chooses every time) and replaces the old
   * tracks. Nothing is asked; a no-op change does nothing. The choice is remembered like the dialog's.
   */
  function reshare(change: { quality?: Quality; audio?: boolean }) {
    if (!room || !get().stream) return Promise.resolve();
    const id = session;
    return serial(async () => {
      const r = room;
      const cur = get().stream;
      if (!r || !active(id) || !cur) return;
      const next: ShareChoice = { ...cur, ...change };
      if (next.audio === cur.audio && next.quality.resolution === cur.quality.resolution && next.quality.fps === cur.quality.fps) return;
      set({ mediaNote: null });
      rememberShare({ ...next.quality, audio: next.audio });
      await goLive(r, id, next);
    });
  }
  function stopScreen() {
    const id = session;
    if (!room || !get().screenEnabled) return Promise.resolve();
    set({ ...SHARE_OFF, mediaNote: null });
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
    if (!track?.setProcessor || !track.stopProcessor || !track.restartTrack || !track.getSourceTrackSettings) return;
    const id = session;
    const level = noise.level();
    const browserFilter = noiseConfig(level).browserNoiseSuppression;
    try {
      const p = noise.processor(level, noiseFailed);
      if (p) await track.setProcessor(p);
      else await track.stopProcessor();
      if (track.getSourceTrackSettings().noiseSuppression !== browserFilter) await track.restartTrack({ noiseSuppression: browserFilter });
      if (active(id) && get().mediaNote?.startsWith(t("voice.media.noiseFailed"))) set({ mediaNote: null }); // it works now: drop the old complaint
    } catch (e) {
      console.error("[noise] switching level failed:", e);
      await track.stopProcessor().catch(() => undefined);
      await track.restartTrack({ noiseSuppression: true }).catch(() => undefined);
      if (active(id)) noiseFailed(reasonOf(e));
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
      stream: canStream ? s.stream : null,
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
      liveSharers = null;
      set({ status: "reconnecting" });
    });
    on("reconnected", () => {
      known = new Set(r.remoteParticipants.keys());
      set({ status: "connected" });
      publicationsChanged();
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
    on("trackSubscribed", (track: { kind: string; source?: string } & AudioTrackLike, _pub: unknown, p?: { identity: string }) => {
      if (track.kind === "audio") {
        sink.add(track);
        if (track.source === Track.Source.ScreenShareAudio && p) {
          streamAudio.set(p.identity, track);
          sink.setVolume(track, streamGain(p.identity));
        } else if (track.source === Track.Source.Microphone && p) {
          micAudio.set(p.identity, track);
          sink.setVolume(track, micGain(p.identity));
        }
      }
      refresh();
    });
    on("trackUnsubscribed", (track: { kind: string; source?: string } & AudioTrackLike, _pub: unknown, p?: { identity: string }) => {
      if (track.kind === "audio") {
        sink.remove(track);
        if (p && streamAudio.get(p.identity) === track) streamAudio.delete(p.identity);
        if (p && micAudio.get(p.identity) === track) micAudio.delete(p.identity);
      }
      refresh();
    });
    on("participantPermissionsChanged", (_prev: unknown, p: { identity: string }) => {
      if (p.identity === r.localParticipant.identity) applyRights(rightsOf(r.localParticipant.permissions));
    });
    on("participantConnected", (p: { identity: string }) => {
      publicationsChanged();
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
      if (pub.source === "screen_share" && !swapping) {
        set(SHARE_OFF);
        void unshare(r); // the picture ended on its own: the sound track of the share goes too
      }
      refresh();
    });
    for (const e of ["participantMetadataChanged", "trackMuted", "trackUnmuted", "localTrackPublished"]) on(e, refresh);
    for (const e of ["trackPublished", "trackUnpublished"]) on(e, publicationsChanged);
  }

  /** Tells the others (cosmetically, see voice-flags) whether we are deafened and whose streams we watch; a refusal (older server) is harmless. */
  const publishFlags = () => void room?.localParticipant.setMetadata(encodeFlags(get())).catch(() => undefined);
  store.subscribe((s, prev) => (s.deafened !== prev.deafened || s.watching.join() !== prev.watching.join()) && publishFlags());

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
    set({ status: "connecting", canSpeak: tok.canSpeak, canVideo: tok.canVideo, canStream: tok.canStream, serverMuted: !!tok.serverMuted, serverDeafened: !!tok.serverDeafened });
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
    startMeter();
    publicationsChanged();
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
      if (s.deafened) return;
      const done = setMic(!s.micEnabled);
      // the intention flips at once (a refused unmute is rare and shows its own note), so the beep is not held up by a slow publish
      if (get().micEnabled !== s.micEnabled) sound(s.micEnabled ? "mute" : "unmute");
      await done;
    },
    toggleCamera: () => setCamera(!get().camEnabled),
    startScreen,
    stopScreen,
    toggleScreen: () => (get().screenEnabled ? stopScreen() : startScreen()),
    /** Live: same source, new resolution / frame rate (the picture restarts). */
    setStreamQuality: (quality: Quality) => reshare({ quality }),
    /** Live: same source, system sound on or off (the picture restarts). */
    setStreamAudio: (audio: boolean) => reshare({ audio }),
    /** Start watching someone's screen share (only a person who is sharing right now); subscribes picture and sound. */
    watch(userId: string) {
      const sharing = get().participants.some((p) => p.userId === userId && !p.isLocal && p.sharing);
      if (!sharing || get().watching.includes(userId)) return;
      set({ watching: [...get().watching, userId] });
      syncStreams();
    },
    unwatch(userId: string) {
      set({ watching: get().watching.filter((id) => id !== userId) });
      syncStreams();
    },
    /** The viewer's slider for one stream's sound (clamped); the microphone of that person is untouched. */
    setStreamVolume(userId: string, volume: number) {
      set({ streamVolume: { ...get().streamVolume, [userId]: clampVolume(volume) } });
      applyStreamAudio();
    },
    setStreamMuted(userId: string, muted: boolean) {
      set({ streamMuted: { ...get().streamMuted, [userId]: muted } });
      applyStreamAudio();
    },
    /** One person's loudness (0..200%) and mute-for-me, remembered per account; applies to their microphone only, never to their stream. */
    setUserVolume(userId: string, patch: Partial<{ volume: number; muted: boolean }>) {
      userVolumes.set(userId, patch);
      applyMicAudio();
    },
    /** Push-to-talk switched on / off (the settings and the key hook's availability decide, see ptt-bridge); the mic follows at once. */
    setPtt(ptt: boolean) {
      if (get().ptt === ptt) return;
      set({ ptt });
      void applyDevice(MIC);
    },
    /** The push-to-talk key went down / up. Outside push-to-talk it changes nothing (the key is not bound to anything then). */
    setPttHeld(pttHeld: boolean) {
      if (get().pttHeld === pttHeld) return;
      set({ pttHeld });
      if (get().ptt) void applyDevice(MIC);
    },
    /** Deafen silences every remote <audio> (nothing is unsubscribed) and the mic; undeafen restores the mic as it was. */
    async toggleDeafen() {
      const s = get();
      if (!room) return;
      if (!s.deafened) {
        sound("mute", false); // heard before the hearing goes; deafened = silent for every other sound
        sink.setMuted(true);
        set({ deafened: true, micBeforeDeafen: s.micEnabled });
        applyStreamAudio();
        applyMicAudio();
        if (s.micEnabled) await setMic(false);
      } else {
        sink.setMuted(false);
        const restore = s.micBeforeDeafen;
        set({ deafened: false, micBeforeDeafen: false });
        sound("unmute");
        applyStreamAudio();
        applyMicAudio();
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
    /**
     * `voice:moderated`: a moderator changed our server mute / deafen. Applies only to the voice channel we are in (an
     * old event or another channel changes nothing); returns the state before, or null when ignored. The rights
     * themselves arrive from LiveKit (ParticipantPermissionsChanged -> canSpeak), this only says why.
     */
    moderated({ channelId, serverMute, serverDeafen }: { channelId: string; serverMute: boolean; serverDeafen: boolean }) {
      const s = get();
      if (s.target?.kind !== "channel" || s.target.id !== channelId || !isActive(s.status)) return null;
      const before = { serverMuted: s.serverMuted, serverDeafened: s.serverDeafened };
      set({ serverMuted: serverMute, serverDeafened: serverDeafen });
      return before;
    },
    notify: (notice: string) => set({ notice }),
    dismissNotice: () => set({ notice: null }),
  };
}
export type Voice = ReturnType<typeof createVoice>;
