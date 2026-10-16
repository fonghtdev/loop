import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAudioSink, type AudioTrackLike } from "./audio-sink";

// The sink drives a DOM element and the Web Audio graph; both are stood in for by plain objects.
const node = () => ({ connect: vi.fn((next: unknown) => next), disconnect: vi.fn() });
let gains: { gain: { value: number }; disconnect: () => void; connect: (n: unknown) => unknown }[];
let sources: number;

beforeEach(() => {
  gains = [];
  sources = 0;
  vi.stubGlobal("document", { body: { appendChild: vi.fn() } });
  vi.stubGlobal(
    "AudioContext",
    class {
      destination = {};
      createGain() {
        const g = { ...node(), gain: { value: 1 } };
        gains.push(g);
        return g;
      }
      createMediaElementSource() {
        sources++;
        return { connect: (g: { connect: (d: unknown) => unknown }) => g };
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

const track = () => {
  const el = { volume: 1, muted: false, hidden: false, remove: vi.fn() };
  return { el, track: { attach: () => el, detach: vi.fn() } as unknown as AudioTrackLike };
};

describe("audio sink volume", () => {
  it("up to 100% it is the element's own volume, no Web Audio", () => {
    const sink = createAudioSink();
    const t = track();
    sink.add(t.track);
    sink.setVolume(t.track, 0.4);
    expect(t.el.volume).toBe(0.4);
    expect(gains).toHaveLength(0);
  });

  it("above 100% the track goes through one gain node, which then follows every later value (also below 1)", () => {
    const sink = createAudioSink();
    const t = track();
    sink.add(t.track);
    sink.setVolume(t.track, 1.7);
    expect(gains).toHaveLength(1);
    expect(gains[0].gain.value).toBe(1.7);
    expect(t.el.volume).toBe(1);
    sink.setVolume(t.track, 0.5);
    sink.setVolume(t.track, 2);
    expect(gains).toHaveLength(1);
    expect(sources).toBe(1);
    expect(gains[0].gain.value).toBe(2);
  });

  it("removing the track disconnects its gain; a track that is not in the sink is ignored", () => {
    const sink = createAudioSink();
    const t = track();
    sink.setVolume(t.track, 1.5);
    expect(gains).toHaveLength(0);
    sink.add(t.track);
    sink.setVolume(t.track, 1.5);
    sink.remove(t.track);
    expect(gains[0].disconnect).toHaveBeenCalled();
  });
});
