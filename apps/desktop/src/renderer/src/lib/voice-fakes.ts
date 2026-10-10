import { vi } from "vitest";
import type { AudioSink, AudioTrackLike } from "./audio-sink";
import { createVoice, type LocalParticipantLike, type ParticipantLike, type RoomLike } from "./voice";

/** A stand-in for livekit-client's Room: an event emitter with the few members the voice session uses. */
export class FakeRoom implements RoomLike {
  handlers = new Map<string, ((...a: never[]) => void)[]>();
  disconnected = 0;
  connectError: Error | null = null;
  mic: boolean[] = [];
  cam: boolean[] = [];
  micFails = false;
  micGate: Promise<void> | null = null;
  remoteParticipants = new Map<string, ParticipantLike>();
  localParticipant: LocalParticipantLike = {
    identity: "me",
    name: "Me",
    permissions: { canPublish: true, canPublishSources: [] },
    getTrackPublication: () => undefined,
    setMicrophoneEnabled: async (on) => {
      await this.micGate;
      if (this.micFails) throw new Error("NotAllowedError");
      this.mic.push(on);
    },
    setCameraEnabled: async (on) => void this.cam.push(on),
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
  addRemote(identity: string, name = identity) {
    this.remoteParticipants.set(identity, { identity, name, getTrackPublication: () => undefined });
    this.fire("participantConnected");
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
  clear() {
    this.tracks.clear();
    this.muted = false;
  }
}

export const audioTrack = () => ({ kind: "audio", attach: () => document.createElement("audio"), detach: () => undefined }) as never;

export function setupVoice(token: Partial<{ canSpeak: boolean; canVideo: boolean; url: string }> = {}, onRoom?: (r: FakeRoom) => void) {
  const rooms: FakeRoom[] = [];
  const sink = new FakeSink();
  const request = vi.fn(async (_m: "POST", _p: string, _b?: unknown): Promise<unknown> => ({ token: "tok", url: "ws://lk", canSpeak: true, canVideo: true, ...token }));
  const ensureMedia = vi.fn(async (_k: string) => true);
  let clock = 1000;
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
    livekitOrigin: "ws://lk",
    now: () => clock,
  });
  return { voice, rooms, room: () => rooms[rooms.length - 1], sink, request, ensureMedia, state: () => voice.store.getState(), tick: (ms: number) => (clock += ms) };
}
