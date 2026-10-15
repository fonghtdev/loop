import { describe, expect, it, vi } from "vitest";
import { COALESCE_MS, createSounds, createTonePlayer, MAX_MS, soundFor, TONES, type SoundKind } from "./sounds";

const on = { enabled: true, deafened: false, sinceLast: Infinity };

describe("tone table", () => {
  for (const [kind, tone] of Object.entries(TONES)) {
    it(`${kind}: under ${MAX_MS} ms, sane pitch, modest gain, ordered notes`, () => {
      const end = Math.max(...tone.notes.map((n) => n.at + n.dur));
      expect(end).toBeLessThan(MAX_MS);
      expect(tone.gain).toBeGreaterThan(0);
      expect(tone.gain).toBeLessThanOrEqual(0.3); // the layers add up to ~2.25x this, still under full scale
      for (const n of tone.notes) {
        for (const hz of [n.from, n.to]) {
          expect(hz).toBeGreaterThanOrEqual(100); // bass-friendly: the sub layer is half of this
          expect(hz).toBeLessThanOrEqual(1000);
        }
        expect(n.dur).toBeGreaterThanOrEqual(40);
        expect(n.at).toBeGreaterThanOrEqual(0);
      }
    });
  }
  it("unmute rises and mute falls", () => {
    expect(TONES.unmute.notes.every((n) => n.to > n.from)).toBe(true);
    expect(TONES.mute.notes.every((n) => n.to < n.from)).toBe(true);
  });
  it("streamStart climbs through two notes, streamStop falls, and neither is the join / leave figure", () => {
    const pitches = (k: SoundKind) => TONES[k].notes.flatMap((n) => [n.from, n.to]);
    const up = pitches("streamStart");
    const down = pitches("streamStop");
    expect(TONES.streamStart.notes).toHaveLength(2);
    expect(TONES.streamStop.notes).toHaveLength(2);
    expect(up).toEqual([...up].sort((a, b) => a - b));
    expect(down).toEqual([...down].sort((a, b) => b - a));
    expect(TONES.streamStart.notes).not.toEqual(TONES.join.notes);
    expect(TONES.streamStop.notes).not.toEqual(TONES.leave.notes);
  });
  it("join rises, leave falls", () => {
    const rises = (k: SoundKind) => TONES[k].notes.every((n) => n.to > n.from);
    const falls = (k: SoundKind) => TONES[k].notes.every((n) => n.to < n.from);
    expect([rises("join"), rises("selfJoin")]).toEqual([true, true]);
    expect([falls("leave"), falls("selfLeave")]).toEqual([true, true]);
    for (const k of ["join", "selfJoin"] as const) {
      const f = TONES[k].notes.map((n) => n.to);
      expect(f).toEqual([...f].sort((a, b) => a - b)); // the whole phrase climbs
    }
    for (const k of ["leave", "selfLeave"] as const) {
      const f = TONES[k].notes.map((n) => n.to);
      expect(f).toEqual([...f].sort((a, b) => b - a)); // and falls
    }
  });
});

describe("soundFor", () => {
  it("plays when on and hearing", () => expect(soundFor("join", on)).toBe("join"));
  it("is silent with the setting off", () => expect(soundFor("join", { ...on, enabled: false })).toBeNull());
  it("is silent while deafened", () => expect(soundFor("selfJoin", { ...on, deafened: true })).toBeNull());
  it("drops the same kind inside the coalescing window and allows it at the edge", () => {
    expect(soundFor("join", { ...on, sinceLast: COALESCE_MS - 1 })).toBeNull();
    expect(soundFor("join", { ...on, sinceLast: COALESCE_MS })).toBe("join");
  });
});

describe("createSounds", () => {
  const setup = (prefs = { enabled: true, volume: 60 }) => {
    let clock = 1000;
    const player = { play: vi.fn(), unlock: vi.fn(), setOutput: vi.fn() };
    const played: SoundKind[] = [];
    const sounds = createSounds({ player, prefs: () => prefs, now: () => clock, onPlay: (k) => played.push(k) });
    return { sounds, player, played, tick: (ms: number) => (clock += ms), prefs };
  };

  it("three joins at once are one tone; a later one plays again; leave is counted separately", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.sounds.handle("join", false);
    s.sounds.handle("leave", false);
    s.tick(COALESCE_MS);
    s.sounds.handle("join", false);
    expect(s.played).toEqual(["join", "leave", "join"]);
    expect(s.player.play).toHaveBeenCalledWith("join", 0.6);
  });

  it("a dropped sound does not extend the window", () => {
    const s = setup();
    s.sounds.handle("join", false);
    s.tick(200);
    s.sounds.handle("join", false);
    s.tick(60);
    s.sounds.handle("join", false);
    expect(s.played).toEqual(["join", "join"]);
  });

  it("setting off or deafened plays nothing; the preview ignores the switch but uses the volume", () => {
    const s = setup({ enabled: false, volume: 30 });
    s.sounds.handle("selfJoin", false);
    s.sounds.handle("join", true);
    expect(s.played).toEqual([]);
    s.sounds.preview();
    expect(s.player.play).toHaveBeenCalledWith("join", 0.3);
  });
});

describe("createTonePlayer", () => {
  const fakeContext = (state = "running") => {
    const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
    const node = () => ({ connect: (n: unknown) => n, gain: param(), frequency: param(), start: vi.fn(), stop: vi.fn(), type: "" });
    return { state, currentTime: 0, destination: {}, resume: vi.fn(async () => undefined), setSinkId: vi.fn(async () => undefined), createGain: vi.fn(node), createOscillator: vi.fn(node), createBiquadFilter: vi.fn(node) };
  };

  it("three layered oscillators per note through one low-pass, resumes a suspended context, routes to the chosen output", () => {
    const c = fakeContext("suspended");
    const p = createTonePlayer(() => c as never);
    p.setOutput("spk");
    p.play("selfJoin", 0.5);
    expect(c.createOscillator).toHaveBeenCalledTimes(TONES.selfJoin.notes.length * 3);
    expect(c.createBiquadFilter).toHaveBeenCalledTimes(1);
    expect(c.resume).toHaveBeenCalled();
    expect(c.setSinkId).toHaveBeenLastCalledWith("spk");
    p.setOutput(null);
    expect(c.setSinkId).toHaveBeenLastCalledWith("");
  });

  it("never throws: no audio context, or a failing sink", () => {
    const broken = createTonePlayer(() => {
      throw new Error("no audio");
    });
    expect(() => (broken.unlock(), broken.play("join", 1))).not.toThrow();
    const c = { ...fakeContext(), setSinkId: vi.fn(async () => Promise.reject(new Error("gone"))) };
    const p = createTonePlayer(() => c as never);
    expect(() => p.play("leave", 1)).not.toThrow();
  });
});
