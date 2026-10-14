import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import type { NoiseConfig } from "./noise";

export type Graph = { output: MediaStreamTrack; destroy(): void };
export type BuildGraph = (input: MediaStreamTrack, gate: NoiseConfig["gate"]) => Promise<Graph>;

/**
 * LiveKit's view of the graph. It never throws: when the worklet or the wasm cannot start, there is no processed
 * track (LiveKit then keeps sending the raw one), the browser's filter is switched back on, and `onFail` tells the user.
 */
export function createNoiseProcessor(config: NoiseConfig, onFail: (reason?: string) => void, build: BuildGraph): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let graph: Graph | undefined;
  const proc: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: "loop-noise",
    async init({ track }) {
      try {
        graph = await build(track, config.gate);
        proc.processedTrack = graph.output;
      } catch (e) {
        console.error("[noise] graph failed:", e);
        proc.processedTrack = undefined;
        await track.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
        onFail(e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 120) : undefined); // the reason is for whoever reports it
      }
    },
    async restart(opts) {
      await proc.destroy();
      await proc.init(opts as AudioProcessorOptions);
    },
    async destroy() {
      graph?.destroy();
      graph = undefined;
      proc.processedTrack = undefined;
    },
  };
  return proc;
}
