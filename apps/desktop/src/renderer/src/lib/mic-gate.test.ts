import { describe, expect, it } from "vitest";
import { micLive } from "./mic-gate";

const base = { micEnabled: true, deafened: false, ptt: false, pttHeld: false };

describe("micLive", () => {
  it("voice activity: the user's own switch decides, the key is irrelevant", () => {
    expect(micLive(base)).toBe(true);
    expect(micLive({ ...base, pttHeld: true })).toBe(true);
    expect(micLive({ ...base, micEnabled: false })).toBe(false);
  });
  it("push-to-talk: open only while the key is held", () => {
    expect(micLive({ ...base, ptt: true })).toBe(false);
    expect(micLive({ ...base, ptt: true, pttHeld: true })).toBe(true);
  });
  it("manual mute always wins: a held key never unmutes a muted user", () => {
    expect(micLive({ ...base, ptt: true, pttHeld: true, micEnabled: false })).toBe(false);
  });
  it("deafen always wins too", () => {
    expect(micLive({ ...base, ptt: true, pttHeld: true, deafened: true })).toBe(false);
    expect(micLive({ ...base, deafened: true })).toBe(false);
  });
});
