import { loadRnnoise, NoiseGateWorkletNode, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import noiseGateWorklet from "@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url";
import rnnoiseWorklet from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasm from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasm from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import type { BuildGraph } from "./noise-processor";

let wasm: Promise<ArrayBuffer> | null = null;
const loadWasm = () => (wasm ??= loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm }).catch((e) => ((wasm = null), Promise.reject(e))));

/** mic -> RNNoise -> (gate) -> a new track, in a 48 kHz context of its own (RNNoise assumes 48 kHz; the room's follows the device). */
export const buildGraph: BuildGraph = async (input, gate) => {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  try {
    const binary = await loadWasm();
    await ctx.audioWorklet.addModule(rnnoiseWorklet);
    if (gate) await ctx.audioWorklet.addModule(noiseGateWorklet);
    const source = ctx.createMediaStreamSource(new MediaStream([input]));
    // ponytail: mono (a voice microphone is); a stereo interface would lose its second channel
    const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
    const dest = ctx.createMediaStreamDestination();
    const gateNode = gate ? new NoiseGateWorkletNode(ctx, { openThreshold: gate.openDb, closeThreshold: gate.closeDb, holdMs: gate.holdMs, maxChannels: 1 }) : null;
    source.connect(rnnoise);
    (gateNode ? rnnoise.connect(gateNode) : rnnoise).connect(dest);
    await ctx.resume();
    return {
      output: dest.stream.getAudioTracks()[0],
      destroy() {
        rnnoise.destroy();
        source.disconnect();
        void ctx.close().catch(() => undefined);
      },
    };
  } catch (e) {
    void ctx.close().catch(() => undefined);
    throw e;
  }
};

