import { describe, expect, it } from "vitest";
import { createSoundPrefs, DEFAULT_SOUND_PREFS, parseSoundPrefs, soundPrefsKey } from "./sound-prefs";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe("parseSoundPrefs", () => {
  it("defaults to on at 60", () => expect(parseSoundPrefs(null)).toEqual({ enabled: true, volume: 60 }));
  it("keeps good values, clamps the volume and repairs each field on its own", () => {
    expect(parseSoundPrefs('{"enabled":false,"volume":20}')).toEqual({ enabled: false, volume: 20 });
    expect(parseSoundPrefs('{"volume":500}').volume).toBe(100);
    expect(parseSoundPrefs('{"volume":-5}').volume).toBe(0);
    expect(parseSoundPrefs('{"enabled":"no","volume":"loud"}')).toEqual(DEFAULT_SOUND_PREFS);
    expect(parseSoundPrefs("{not json")).toEqual(DEFAULT_SOUND_PREFS);
  });
});

describe("createSoundPrefs", () => {
  it("saves per account; another account and sign-out see the defaults", () => {
    const store = memory();
    const p = createSoundPrefs(() => store);
    p.load("u1");
    p.set({ enabled: false });
    p.set({ volume: 35 });
    expect(JSON.parse(store.data.get(soundPrefsKey("u1"))!)).toEqual({ enabled: false, volume: 35 });
    p.load("u2");
    expect(p.get()).toEqual(DEFAULT_SOUND_PREFS);
    p.load("u1");
    expect(p.get()).toEqual({ enabled: false, volume: 35 });
    p.load(null);
    expect(p.get()).toEqual(DEFAULT_SOUND_PREFS);
  });

  it("a blocked storage still holds the choice for this run, a signed-out set is not stored, listeners hear changes", () => {
    const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    const p = createSoundPrefs(() => broken);
    let heard = 0;
    p.subscribe(() => heard++);
    p.load("u1");
    p.set({ volume: 10 });
    expect(p.get().volume).toBe(10);
    expect(heard).toBe(2);
    const store = memory();
    const q = createSoundPrefs(() => store);
    q.set({ enabled: false });
    expect(store.data.size).toBe(0);
  });
});
