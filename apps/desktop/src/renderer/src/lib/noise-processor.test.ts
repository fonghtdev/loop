import { describe, expect, it, vi } from "vitest";
import { noiseConfig } from "./noise";
import { createNoiseProcessor, type BuildGraph } from "./noise-processor";

const opts = () => {
  const track = { applyConstraints: vi.fn(async () => undefined) };
  return { track, o: { kind: "audio", track, audioContext: {} } as never };
};

describe("createNoiseProcessor", () => {
  it("exposes the graph's track and passes the gate through", async () => {
    const out = { id: "out" } as never;
    const destroy = vi.fn();
    const build = vi.fn<BuildGraph>(async () => ({ output: out, destroy }));
    const p = createNoiseProcessor(noiseConfig("strong"), vi.fn(), build);
    const { o } = opts();
    await p.init(o);
    expect(p.processedTrack).toBe(out);
    expect(build.mock.calls[0][1]).toEqual(noiseConfig("strong").gate);
    await p.destroy();
    expect(destroy).toHaveBeenCalled();
    expect(p.processedTrack).toBeUndefined();
  });

  it("never throws when the graph cannot start: no processed track, browser filter back on, caller told", async () => {
    const onFail = vi.fn();
    const p = createNoiseProcessor(noiseConfig("standard"), onFail, async () => {
      throw new Error("wasm blocked");
    });
    const { track, o } = opts();
    await expect(p.init(o)).resolves.toBeUndefined();
    expect(p.processedTrack).toBeUndefined();
    expect(track.applyConstraints).toHaveBeenCalledWith({ noiseSuppression: true });
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith("Error: wasm blocked");
  });

  it("restart rebuilds on the new track and frees the old graph", async () => {
    const destroy = vi.fn();
    const build = vi.fn<BuildGraph>(async () => ({ output: {} as never, destroy }));
    const p = createNoiseProcessor(noiseConfig("standard"), vi.fn(), build);
    await p.init(opts().o);
    await p.restart(opts().o);
    expect(build).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
