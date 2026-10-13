/** The four voice-room sounds. join/leave = someone else, self* = us. */
export type SoundKind = "join" | "leave" | "selfJoin" | "selfLeave";
type Note = { freq: number; /** ms from the start of the sound */ at: number; /** ms, release included */ dur: number };
type Tone = { wave: OscillatorType; /** peak gain of one note, 0..1 */ gain: number; notes: Note[] };

/** THE tone table: tune the sounds here (notes in Hz and ms). Each sound ends before MAX_MS (a test keeps it so). */
export const TONES: Record<SoundKind, Tone> = {
  join: { wave: "triangle", gain: 0.5, notes: [{ freq: 740, at: 0, dur: 100 }, { freq: 988, at: 100, dur: 160 }] },
  leave: { wave: "triangle", gain: 0.5, notes: [{ freq: 740, at: 0, dur: 100 }, { freq: 494, at: 100, dur: 160 }] },
  selfJoin: { wave: "triangle", gain: 0.45, notes: [{ freq: 587, at: 0, dur: 110 }, { freq: 740, at: 110, dur: 110 }, { freq: 880, at: 220, dur: 170 }] },
  selfLeave: { wave: "triangle", gain: 0.45, notes: [{ freq: 659, at: 0, dur: 120 }, { freq: 440, at: 120, dur: 190 }] },
};
export const MAX_MS = 400;
/** At most one sound per kind inside this window (3 people joining at once = one tone): the first plays, the rest are dropped. */
export const COALESCE_MS = 250;
const ATTACK_S = 0.008;

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

/** Web Audio synthesis, no files: every note is an oscillator with a short attack and an exponential release (no clicks). Never throws. */
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
        master.connect(c.destination);
        for (const n of tone.notes) {
          const t0 = c.currentTime + n.at / 1000;
          const t1 = t0 + n.dur / 1000;
          const osc = c.createOscillator();
          const env = c.createGain();
          osc.type = tone.wave;
          osc.frequency.value = n.freq;
          env.gain.setValueAtTime(0.0001, t0);
          env.gain.linearRampToValueAtTime(tone.gain, t0 + ATTACK_S);
          env.gain.exponentialRampToValueAtTime(0.0001, t1);
          osc.connect(env).connect(master);
          osc.start(t0);
          osc.stop(t1 + 0.02);
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
