/** The voice-room sounds. join/leave = someone else, self* = us; unmute/mute = we flipped our mic or hearing; streamStart/streamStop = anyone in the room began / ended a screen share. */
export type SoundKind = "join" | "leave" | "selfJoin" | "selfLeave" | "unmute" | "mute" | "streamStart" | "streamStop";
type Note = { from: number; /** Hz at the end of the glide (the note slides from `from` to `to`) */ to: number; /** ms from the start of the sound */ at: number; /** ms, release included */ dur: number };
type Tone = { /** peak gain of the main layer, 0..1 (the layers add up to about 2.25x this) */ gain: number; notes: Note[] };

/** Each note is three sine layers: the pitch, a sub-octave (the "bass body") and a soft 2nd harmonic (so small speakers, which cannot play the sub, still carry the warmth). */
const LAYERS = [
  { mult: 1, gain: 1 },
  { mult: 0.5, gain: 0.9 },
  { mult: 2, gain: 0.35 },
];
const GLIDE = 0.35; // share of a note spent sliding to its target pitch
const LOWPASS_HZ = 1800; // rounds the sound off, no harsh top

/** THE tone table: tune the sounds here (notes in Hz and ms). Each sound ends before MAX_MS (a test keeps it so). join rises, leave falls. */
export const TONES: Record<SoundKind, Tone> = {
  join: { gain: 0.22, notes: [{ from: 196, to: 262, at: 0, dur: 220 }, { from: 262, to: 330, at: 110, dur: 260 }] },
  leave: { gain: 0.22, notes: [{ from: 262, to: 196, at: 0, dur: 220 }, { from: 196, to: 147, at: 110, dur: 260 }] },
  selfJoin: { gain: 0.2, notes: [{ from: 196, to: 262, at: 0, dur: 200 }, { from: 262, to: 330, at: 100, dur: 200 }, { from: 330, to: 392, at: 200, dur: 190 }] },
  unmute: { gain: 0.2, notes: [{ from: 330, to: 440, at: 0, dur: 100 }] },
  mute: { gain: 0.2, notes: [{ from: 440, to: 294, at: 0, dur: 100 }] },
  streamStart: { gain: 0.2, notes: [{ from: 392, to: 440, at: 0, dur: 120 }, { from: 523, to: 659, at: 110, dur: 180 }] },
  streamStop: { gain: 0.2, notes: [{ from: 659, to: 587, at: 0, dur: 120 }, { from: 440, to: 330, at: 110, dur: 180 }] },
  selfLeave: { gain: 0.2, notes: [{ from: 330, to: 247, at: 0, dur: 200 }, { from: 247, to: 165, at: 110, dur: 270 }] },
};
export const MAX_MS = 400;
/** At most one sound per kind inside this window (3 people joining at once = one tone): the first plays, the rest are dropped. */
export const COALESCE_MS = 250;
const ATTACK_S = 0.006;

export type SoundState = { enabled: boolean; deafened: boolean; /** ms since this kind last played */ sinceLast: number };

/** Whether a sound plays now: the setting is on, we can hear (deafened = silent; a muted mic does not matter), and the same kind did not just play. */
export function soundFor(kind: SoundKind, { enabled, deafened, sinceLast }: SoundState): SoundKind | null {
  return enabled && !deafened && sinceLast >= COALESCE_MS ? kind : null;
}

export type TonePlayer = {
  play(kind: SoundKind, volume: number): void;
  /** Creates / resumes the audio context; call from a user gesture (joining is one). */
  unlock(): void;
  /** The speaker (an output device id, null = system default). */
  setOutput(deviceId: string | null): void;
};

type Ctx = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** Web Audio synthesis, no files: every note is three oscillators (see LAYERS) with a short attack and an exponential release (no clicks). Never throws. */
export function createTonePlayer(makeContext: () => Ctx = () => new AudioContext()): TonePlayer {
  let ctx: Ctx | null = null;
  let output: string | null = null;
  const route = () => void ctx?.setSinkId?.(output ?? "").catch(() => undefined); // no setSinkId / device gone: the default speaker
  const ready = () => {
    if (!ctx) {
      ctx = makeContext();
      route();
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return ctx;
  };
  return {
    unlock() {
      try {
        ready();
      } catch {
        // no audio: the voice session carries on silently
      }
    },
    setOutput(id) {
      output = id;
      route();
    },
    play(kind, volume) {
      try {
        const c = ready();
        const tone = TONES[kind];
        const master = c.createGain();
        master.gain.value = volume;
        const lowpass = c.createBiquadFilter();
        lowpass.type = "lowpass";
        lowpass.frequency.value = LOWPASS_HZ;
        lowpass.connect(master).connect(c.destination);
        for (const n of tone.notes) {
          const t0 = c.currentTime + n.at / 1000;
          const t1 = t0 + n.dur / 1000;
          for (const layer of LAYERS) {
            const osc = c.createOscillator();
            const env = c.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(n.from * layer.mult, t0);
            osc.frequency.exponentialRampToValueAtTime(n.to * layer.mult, t0 + (n.dur / 1000) * GLIDE);
            env.gain.setValueAtTime(0.0001, t0);
            env.gain.linearRampToValueAtTime(tone.gain * layer.gain, t0 + ATTACK_S);
            env.gain.exponentialRampToValueAtTime(0.0001, t1);
            osc.connect(env).connect(lowpass);
            osc.start(t0);
            osc.stop(t1 + 0.02);
          }
        }
      } catch {
        // never break the voice session over a beep
      }
    },
  };
}

type Deps = {
  player: TonePlayer;
  prefs: () => { enabled: boolean; volume: number };
  now?: () => number;
  /** Observes every sound that really plays (the e2e counter). */
  onPlay?: (kind: SoundKind) => void;
};

/** Decides (soundFor) and plays. `volume` in the prefs is 0..100. */
export function createSounds({ player, prefs, now = Date.now, onPlay }: Deps) {
  const last = new Map<SoundKind, number>();
  const volume = () => prefs().volume / 100;
  return {
    handle(kind: SoundKind, deafened: boolean) {
      const t = now();
      if (!soundFor(kind, { enabled: prefs().enabled, deafened, sinceLast: t - (last.get(kind) ?? -Infinity) })) return;
      last.set(kind, t);
      onPlay?.(kind);
      player.play(kind, volume());
    },
    /** The settings' "Nghe thử": the join tone at the chosen volume, whatever the switch says. */
    preview: () => player.play("join", volume()),
    unlock: () => player.unlock(),
  };
}
