/** How hard the microphone is cleaned: off = the browser's own filter, standard = RNNoise, strong = RNNoise + noise gate. */
export type NoiseLevel = "off" | "standard" | "strong";
export const NOISE_LEVELS: NoiseLevel[] = ["off", "standard", "strong"];
export const DEFAULT_NOISE_LEVEL: NoiseLevel = "standard";

export type NoiseConfig = {
  /** The browser's own `noiseSuppression` capture constraint: only while RNNoise is not running (two filters in a row smear the voice). */
  browserNoiseSuppression: boolean;
  rnnoise: boolean;
  /** Closes the line under a level (dBFS) after `holdMs` of quiet; null = no gate. */
  gate: { openDb: number; closeDb: number; holdMs: number } | null;
};

// ponytail: the gate follows the loudness after RNNoise (the package exposes no VAD); the thresholds are a guess to tune by ear
const GATE = { openDb: -45, closeDb: -50, holdMs: 200 };

export function noiseConfig(level: NoiseLevel): NoiseConfig {
  if (level === "off") return { browserNoiseSuppression: true, rnnoise: false, gate: null };
  return { browserNoiseSuppression: false, rnnoise: true, gate: level === "strong" ? GATE : null };
}

/** The stored value back into a level; anything unknown (an older version, a corrupt file) is the default. */
export const parseNoiseLevel = (raw: string | null): NoiseLevel => NOISE_LEVELS.find((l) => l === raw) ?? DEFAULT_NOISE_LEVEL;

type Deps = { storage: { read(): string | null; write(value: string): void }; onChange: () => void };

/** The user's choice, kept in localStorage like the device choices (not sensitive); `onChange` brings a live session in step. */
export function createNoiseLevel({ storage, onChange }: Deps) {
  let level: NoiseLevel = DEFAULT_NOISE_LEVEL;
  try {
    level = parseNoiseLevel(storage.read());
  } catch {
    // storage unavailable: the default
  }
  return {
    get: () => level,
    set(next: NoiseLevel) {
      level = next;
      try {
        storage.write(next);
      } catch {
        // a lost preference is harmless
      }
      onChange();
    },
  };
}
