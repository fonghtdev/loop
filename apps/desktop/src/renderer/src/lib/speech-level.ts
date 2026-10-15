/** A source of one track's loudness: `read()` = current level in dBFS (-Infinity = silence), `close()` frees it. */
export type LevelProbe = { read(): number; close(): void };
/** Starts measuring a MediaStreamTrack (never plays it); null = cannot (no AudioContext, ...). */
export type TapAudio = (track: MediaStreamTrack) => LevelProbe | null;

// ponytail: a guess, tune by ear. Speech RMS is roughly -45..-15 dBFS, a quiet room about -60.
export const SPEECH = { onDb: -48, offDb: -54, holdMs: 300 };

/**
 * Speaking from levels, one detector per person: on at once when the level reaches `onDb`; once on, it stays on
 * while the level stays above `offDb` and for `holdMs` after the last such moment (no flicker between words).
 */
export function createSpeechDetector({ onDb, offDb, holdMs } = SPEECH) {
  let on = false;
  let lastLoud = 0;
  return (db: number, nowMs: number): boolean => {
    if (db >= onDb || (on && db > offDb)) {
      on = true;
      lastLoud = nowMs;
    } else if (on && nowMs - lastLoud >= holdMs) on = false;
    return on;
  };
}

/** Root-mean-square of float samples (-1..1) in dBFS. */
export function rmsDb(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return 10 * Math.log10(sum / samples.length);
}

// One AudioContext for all analysers, closed with the last probe so nothing outlives a session.
let ctx: AudioContext | null = null;
let open = 0;

/** The real tap: track -> AnalyserNode, NOT connected to the destination (the <audio> elements stay the only sound). */
export const tapAudio: TapAudio = (track) => {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    open++;
    return {
      read: () => {
        analyser.getFloatTimeDomainData(buf);
        return rmsDb(buf);
      },
      close() {
        source.disconnect();
        if (--open > 0) return;
        void ctx?.close().catch(() => undefined);
        ctx = null;
      },
    };
  } catch {
    return null;
  }
};
